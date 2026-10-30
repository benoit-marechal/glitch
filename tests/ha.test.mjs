import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = join(root, 'compose.yaml');
const baseUrl = 'http://127.0.0.1:8088';
const composeProject = process.env.COMPOSE_PROJECT_NAME ?? 'billeterie';
const pgServices = ['pg1', 'pg2', 'pg3'];
const etcdServices = ['etcd1', 'etcd2', 'etcd3'];
const requiredServices = ['lb', 'web1', 'web2', 'sql1', 'sql2', ...pgServices, ...etcdServices];
const affectedServices = new Set();
const runId = randomUUID();
const startedAt = new Date();
const reportPath = join(root, 'reports', `ha-${startedAt.toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`);
const report = {
  started_at: startedAt.toISOString(),
  run_id: runId,
  project: composeProject,
  docker_context: 'orbstack',
  endpoint: baseUrl,
  versions: { node: process.version, runner_os: process.platform, runner_arch: process.arch },
  scenarios: [],
  invariants: {},
  cleanup: [],
  limits: [
    'Tous les conteneurs partagent le Mac, son noyau et son disque via OrbStack.',
    'Cette recette ne valide ni une panne de VM ou de zone, ni un fencing indépendant.',
    'Les réservations synthétiques restent dans la base. Aucune table ni aucun volume ne sont effacés.',
  ],
};
let interrupted = false;
let baseline;
let patroniConfig;

// Appelé par les signaux du terminal pour laisser finally restaurer les services.
// Sans ce drapeau, une interruption pourrait laisser une panne de recette active.
function handleInterrupt() {
  interrupted = true;
}

process.on('SIGINT', handleInterrupt);
process.on('SIGTERM', handleInterrupt);

// Toutes les phases passent ici pour borner Docker et garder ses erreurs utiles.
// Sans cet adaptateur, chaque appel devrait vérifier son statut et son délai.
function docker(args, { timeout = 20_000, allowFailure = false } = {}) {
  const result = spawnSync('docker', ['--context', 'orbstack', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  if ((result.error || result.status !== 0) && !allowFailure) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 1500);
    throw new Error(`Docker ${args[0]} : code ${result.status ?? 'indisponible'}${result.signal ? `, signal ${result.signal}` : ''}. ${detail}`);
  }
  return { ok: !result.error && result.status === 0, output: result.stdout?.trim() ?? '', error: result.stderr?.trim() || result.error?.message || '' };
}

// Le pilotage passe toujours par ce projet et ce fichier absolus pendant la recette.
// Sans ce périmètre fixe, un arrêt pourrait viser une autre installation Compose.
function compose(args, options) {
  return docker(['compose', '-p', composeProject, '--project-directory', root, '-f', composeFile, ...args], options);
}

// Les assertions de données utilisent uniquement des identifiants synthétiques validés.
// Appelée par les contrôles SQL, cette fonction évite de concaténer un identifiant libre.
function sqlLiteral(value) {
  assert.match(String(value), /^[a-zA-Z0-9-]+$/, 'Identifiant SQL synthétique inattendu');
  return `'${value}'`;
}

// Les contrôles des copies passent par le socket local, sans lire les secrets.
// Sans cette fonction, un succès HTTP ne prouverait pas les données de chaque nœud.
function sql(service, query, options) {
  assert.ok(pgServices.includes(service), 'Service PostgreSQL hors périmètre');
  return compose(['exec', '-T', '-u', 'postgres', service, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'festival', '-Atc', query], options);
}

// Les contrôles REST internes ne publient que les champs non secrets utiles au test.
// Appelée pour Patroni et etcd, elle évite un port supplémentaire sur le Mac.
function internalJson(service, url, projection = 'value') {
  assert.ok(pgServices.includes(service), 'Service de sonde hors périmètre');
  const script = `import json, urllib.request\nwith urllib.request.urlopen(${JSON.stringify(url)}, timeout=3) as response:\n value=json.load(response)\nprint(json.dumps(${projection}))`;
  const result = compose(['exec', '-T', service, '/opt/venv/bin/python', '-c', script], { timeout: 8_000 });
  return JSON.parse(result.output);
}

// Après un arrêt, cette lecture essaie les nœuds encore présents pour voir le leader.
// Sans elle, la sonde serait elle-même indisponible si pg1 était le nœud arrêté.
function cluster(candidates = pgServices) {
  const errors = [];
  for (const service of candidates) {
    try {
      const value = internalJson(service, `http://${service}:8008/cluster`, "{'members': [{k: member.get(k) for k in ('name', 'role', 'state', 'lag', 'timeline')} for member in value.get('members', [])]}");
      assert.ok(Array.isArray(value.members) && value.members.length > 0, 'Patroni ne fournit aucun membre');
      return value.members;
    } catch (error) {
      errors.push(`${service}: ${error.message}`);
    }
  }
  throw new Error(`Patroni inaccessible : ${errors.join(' | ')}`);
}

// Les tests de basculement ont besoin d'un primaire unique constaté par Patroni.
// Sans ce contrôle, tuer un nœud nommé à l'avance ne prouverait pas un basculement.
function primary(members) {
  const leaders = members.filter(member => ['leader', 'master', 'primary'].includes(member.role));
  assert.equal(leaders.length, 1, 'Un seul primaire PostgreSQL est attendu');
  assert.ok(pgServices.includes(leaders[0].name), 'Nom de primaire inattendu');
  return leaders[0].name;
}

// Chaque boucle de disponibilité conserve la dernière erreur et attend entre sondes.
// Appelée après une panne ou une restauration, elle borne l'attente sans masquer sa cause.
async function eventually(label, operation, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    if (interrupted) throw new Error('Recette interrompue, restauration demandée');
    try {
      return await operation();
    } catch (error) {
      if (error.retryable === false) throw error;
      lastError = error;
    }
    if (Date.now() < deadline) await sleep(750);
  } while (Date.now() < deadline);
  throw new Error(`${label} après ${timeoutMs / 1000} s. Dernier échec : ${lastError?.message ?? 'aucun résultat'}`);
}

// Les scénarios HTTP réutilisent le même point d'entrée avec un délai client borné.
// Sans cet appel, une requête suspendue empêcherait le nettoyage de la recette.
async function http(path, { method = 'GET', key, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Connection': 'close', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  let value;
  try {
    value = await response.json();
  } catch {
    const error = new Error(`${method} ${path} : réponse ${response.status} sans JSON valide`);
    error.retryable = [502, 503, 504].includes(response.status);
    throw error;
  }
  return { status: response.status, value };
}

// Une tentative garde sa clé et sa charge entre reprises, y compris après commit incertain.
// Les tests de panne l'utilisent pour ne jamais créer un deuxième achat par retry.
function newBooking(label) {
  return { key: randomUUID(), body: { event_id: 1, name: `HA ${label} ${runId.slice(0, 8)}`, payment: 'accepted' } };
}

// Les reprises acceptent uniquement 503 ou une coupure réseau, puis rejouent la même clé.
// Sans ce contrôle, un 409/422 pourrait être pris à tort pour un délai de basculement.
async function confirmBooking(attempt, { retry = false } = {}) {
  const operation = async () => {
    let response;
    try {
      response = await http('/api/bookings', { method: 'POST', ...attempt });
    } catch (error) {
      if (retry && error.retryable === true) throw error;
      if (!retry || !['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)) {
        error.retryable = false;
        throw error;
      }
      throw new Error(`Transport HTTP pendant la reprise : ${error.message}`);
    }
    if (response.status === 503 && retry) throw new Error('SQL temporairement indisponible (503)');
    if (![200, 201].includes(response.status)) {
      const error = new Error(`Réservation : 200/201 attendu, reçu ${response.status}`);
      error.retryable = false;
      throw error;
    }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(response.value.booking?.id ?? '')) {
      const error = new Error('Réservation 200/201 sans identifiant UUID valide');
      error.retryable = false;
      throw error;
    }
    return { id: response.value.booking.id, status: response.status, node: response.value.node };
  };
  if (!retry) return operation();
  return eventually('Écriture HTTP après reprise', operation);
}

// Cette vérification compare chaque copie après les écritures et les réintégrations.
// Sans elle, un cluster disponible pourrait encore avoir perdu une réservation confirmée.
async function replicatedBooking(id, services = pgServices) {
  return eventually(`Réplication de la réservation sur ${services.join(', ')}`, () => {
    const copies = {};
    for (const service of services) {
      copies[service] = Number(sql(service, `SELECT count(*) FROM bookings WHERE id = ${sqlLiteral(id)};`).output);
      assert.equal(copies[service], 1, `${service} doit contenir exactement une copie de la réservation confirmée`);
    }
    return copies;
  });
}

// Avant et après une perturbation, la recette exige un primaire et deux WAL receivers actifs.
// Sans ces preuves SQL et HTTP, un simple conteneur démarré serait déclaré sain à tort.
async function healthyCluster({ checkEtcd = true } = {}) {
  return eventually('Cluster complet sain', async () => {
    const members = cluster();
    assert.equal(members.length, 3, 'Les trois membres Patroni doivent être visibles');
    const leader = primary(members);
    for (const service of pgServices) {
      const state = sql(service, "SELECT CASE WHEN pg_is_in_recovery() THEN COALESCE((SELECT status FROM pg_stat_wal_receiver LIMIT 1), 'absent') ELSE 'primary' END;").output;
      assert.equal(state, service === leader ? 'primary' : 'streaming', `${service} doit répliquer ou être primaire`);
    }
    if (checkEtcd) {
      for (const service of etcdServices) {
        const health = internalJson(leader, `http://${service}:2379/health`);
        assert.ok(health.health === true || health.health === 'true', `${service} n'est pas sain`);
      }
    }
    const status = await http('/api/status');
    assert.equal(status.status, 200, '/api/status doit répondre');
    return { primary: leader, members };
  });
}

// Le nettoyage démarre seulement les services touchés par cette recette, même après échec.
// Appelé dans finally, il évite de laisser le lab avec une panne volontaire active.
async function restore(services) {
  if (services.length === 0) return;
  const begin = Date.now();
  try {
    compose(['start', ...services], { timeout: 60_000 });
    report.cleanup.push({ services, status: 'started', duration_ms: Date.now() - begin });
  } catch (error) {
    report.cleanup.push({ services, status: 'failed', duration_ms: Date.now() - begin, error: error.message });
    throw error;
  }
}

// Chaque panne enregistre sa cible avant mutation et la restaure dans un finally local.
// Sans ce cadre, une assertion échouée entre stop et start abandonnerait le service arrêté.
async function duringOutage(services, operation, { brutal = false } = {}) {
  for (const service of services) {
    assert.ok(requiredServices.includes(service), 'Service de panne hors périmètre');
    affectedServices.add(service);
  }
  let failure;
  try {
    // stop -t 0 impose l'arrêt sans délai et désactive le redémarrage automatique.
    // kill seul serait immédiatement compensé par restart: unless-stopped.
    compose(['stop', '-t', brutal ? '0' : '2', ...services]);
    return await operation();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await restore(services);
      await healthyCluster();
    } catch (cleanupError) {
      if (failure) throw new AggregateError([failure, cleanupError], `${failure.message}. Restauration : ${cleanupError.message}`);
      throw cleanupError;
    }
  }
}

// Le runner Node natif exécute les scénarios séquentiellement et nourrit le rapport JSON.
// Sans cet adaptateur, les mesures et les erreurs ne seraient pas associées à leur scénario.
async function scenario(name, operation) {
  const result = { name, status: 'running', started_at: new Date().toISOString() };
  const begin = Date.now();
  report.scenarios.push(result);
  await test(name, { concurrency: false }, async () => {
    try {
      result.details = await operation();
      result.status = 'passed';
    } catch (error) {
      result.status = 'failed';
      result.error = error.message;
      throw error;
    } finally {
      result.duration_ms = Date.now() - begin;
    }
  });
  if (result.status === 'failed') throw new Error(`Scénario échoué : ${name}. ${result.error}`);
}

// La recette relève ses versions réelles pour interpréter les résultats OrbStack.
// Appelée au début, elle évite d'attribuer les tests à une image ou une plateforme supposée.
function collectVersions() {
  report.versions.docker_client = docker(['--version']).output;
  report.versions.compose = docker(['compose', 'version', '--short']).output;
  const server = JSON.parse(docker(['version', '--format', '{{json .Server}}']).output);
  report.versions.docker_server = { version: server.Version, os: server.Os, arch: server.Arch };
  report.versions.engine_kernel = docker(['info', '--format', '{{.KernelVersion}}']).output;
  report.versions.postgresql = sql('pg1', 'SHOW server_version;').output;
  report.versions.patroni = compose(['exec', '-T', 'pg1', '/opt/venv/bin/patroni', '--version']).output;
  report.versions.etcd = compose(['exec', '-T', 'etcd1', 'etcd', '--version']).output;
  report.versions.images = JSON.parse(compose(['images', '--format', 'json']).output);
}

// Le scénario de blocage exige un 503, en création puis avec la même clé si fournie.
// Appelé pendant la panne, il garde les mesures même en échec et évite de confondre 503 et timeout.
async function blockedBooking(label, attempt = newBooking(label)) {
  const begin = Date.now();
  const observation = { label, client_timeout_ms: 10_000 };
  const currentScenario = report.scenarios.at(-1);
  currentScenario.probes ??= [];
  currentScenario.probes.push(observation);
  try {
    const response = await http('/api/bookings', { method: 'POST', ...attempt });
    observation.response_status = response.status;
    assert.equal(response.status, 503, `${label} : aucune confirmation 200/201 n'est permise pendant la panne, 503 attendu`);
    return { attempt, status: response.status, duration_ms: Date.now() - begin };
  } catch (error) {
    observation.error = `${error.name}: ${error.message}`;
    throw new Error(`${label} après ${Date.now() - begin} ms (limite client 10000 ms) : ${error.message}`);
  } finally {
    observation.duration_ms = Date.now() - begin;
    console.log(`Sonde HA « ${label} » : ${observation.response_status ? `HTTP ${observation.response_status}` : observation.error}, ${observation.duration_ms} ms (limite client 10000 ms).`);
  }
}

// Après un 503, le même achat est rejoué pour résoudre un COMMIT éventuellement déjà local.
// Sans cette reprise, la recette confondrait résultat incertain et annulation garantie.
async function resolveUncertain(attempt) {
  const booking = await confirmBooking(attempt, { retry: true });
  const replay = await confirmBooking(attempt);
  assert.equal(replay.status, 200, 'Le second rejeu doit retrouver l’achat');
  assert.equal(replay.id, booking.id, 'Un résultat incertain doit converger vers le même billet');
  const leader = primary(cluster());
  const count = Number(sql(leader, `SELECT count(*) FROM booking_requests AS requests JOIN bookings ON bookings.id = requests.booking_id WHERE requests.idempotency_key = ${sqlLiteral(attempt.key)};`).output);
  assert.equal(count, 1, 'Une clé doit correspondre à exactement un billet après reprise');
  await replicatedBooking(booking.id);
  return { booking_id: booking.id, first_retry_status: booking.status, replay_status: replay.status, booking_count: count };
}

// Le contrôle de stock encadre les scénarios incertains sans supprimer les données existantes.
// Appelé avant et après, il détecte un double achat que le seul code HTTP ne montrerait pas.
function reservedCount() {
  return Number(sql(primary(cluster()), 'SELECT reserved_count FROM events WHERE id = 1;').output);
}

// Le point d'entrée orchestre les pannes et écrit un rapport même en cas d'échec.
// Sans son finally global, une erreur de préparation pourrait priver la recette de preuve ou de nettoyage.
async function main() {
  console.log(`Rapport de recette prévu : ${reportPath}`);
  try {
    await scenario('Préconditions : OrbStack, trois PostgreSQL et trois etcd', async () => {
      const state = await healthyCluster();
      collectVersions();
      patroniConfig = internalJson(state.primary, `http://${state.primary}:8008/config`, "{k: value.get(k) for k in ('ttl', 'loop_wait', 'retry_timeout', 'synchronous_mode', 'synchronous_mode_strict', 'synchronous_node_count', 'failsafe_mode')}");
      assert.equal(patroniConfig.synchronous_mode, true, 'Le mode synchrone Patroni doit être actif');
      assert.equal(patroniConfig.synchronous_mode_strict, true, 'Le mode synchrone strict doit être actif');
      assert.ok(!patroniConfig.failsafe_mode, 'Le test de perte de quorum exige failsafe_mode désactivé');
      assert.ok(Number.isFinite(patroniConfig.ttl) && patroniConfig.ttl > 0, 'TTL Patroni absent');
      const events = await http('/api/events');
      assert.equal(events.status, 200);
      const event = events.value.events?.find(candidate => Number(candidate.id) === 1);
      assert.ok(event, 'Concert de test 1 absent');
      assert.equal(event.capacity, 200, 'Capacité du concert de test 1 inattendue');
      assert.ok(event.remaining >= 7, 'Au moins sept places libres sur le concert 1 sont requises pour cette recette');
      report.patroni_config = patroniConfig;
      return state;
    });

    await scenario('Réservation confirmée, rejeu unique et réplication sur les trois copies', async () => {
      const attempt = newBooking('référence');
      baseline = await confirmBooking(attempt);
      assert.equal(baseline.status, 201, 'La première réservation doit être créée');
      const replay = await confirmBooking(attempt);
      assert.equal(replay.status, 200, 'Le rejeu doit répondre 200');
      assert.equal(replay.id, baseline.id, 'Le rejeu doit renvoyer la même réservation');
      const copies = await replicatedBooking(baseline.id);
      report.invariants.baseline_replicated = true;
      return { booking_id: baseline.id, replay_status: replay.status, copies };
    });

    await scenario('Répartition HTTP sur deux frontaux', async () => {
      const counts = {};
      for (let index = 0; index < 12; index += 1) {
        const response = await http('/api/status');
        assert.equal(response.status, 200);
        assert.ok(['web1', 'web2'].includes(response.value.node), 'Identité de frontal inattendue');
        counts[response.value.node] = (counts[response.value.node] || 0) + 1;
      }
      assert.deepEqual(Object.keys(counts).sort(), ['web1', 'web2'], 'Les deux frontaux doivent recevoir des requêtes');
      return { requests: 12, nodes: counts };
    });

    await scenario('Arrêt de web1 : lectures et écritures via web2', async () => duringOutage(['web1'], async () => {
      await eventually('Retrait de web1 du répartiteur', async () => {
        const status = await http('/api/status');
        assert.equal(status.status, 200);
        assert.equal(status.value.node, 'web2');
      });
      const booking = await confirmBooking(newBooking('frontal'), { retry: true });
      assert.equal(booking.node, 'web2');
      const stored = await http(`/api/bookings/${baseline.id}`);
      assert.equal(stored.status, 200);
      assert.equal(stored.value.booking?.id, baseline.id);
      return { surviving_node: booking.node, booking_id: booking.id };
    }));

    await scenario('Arrêt sans délai du primaire : nouveau primaire, écriture et réintégration', async () => {
      const oldPrimary = primary(cluster());
      const begin = Date.now();
      let result;
      await duringOutage([oldPrimary], async () => {
        const candidates = pgServices.filter(service => service !== oldPrimary);
        const newPrimary = await eventually('Élection d’un autre primaire', () => {
          const leader = primary(cluster(candidates));
          assert.notEqual(leader, oldPrimary, 'Le primaire arrêté ne doit plus être leader');
          return leader;
        });
        const booking = await confirmBooking(newBooking('basculement'), { retry: true });
        const copies = await replicatedBooking(baseline.id, candidates);
        result = { old_primary: oldPrimary, new_primary: newPrimary, failure_command: 'docker compose stop -t 0', write_restored_ms: Date.now() - begin, booking_id: booking.id, baseline_copies_during_outage: copies };
      }, { brutal: true });
      result.baseline_copies_after_rejoin = await replicatedBooking(baseline.id);
      result.new_booking_copies_after_rejoin = await replicatedBooking(result.booking_id);
      report.invariants.confirmed_booking_survives_primary_loss = true;
      report.invariants.former_primary_rejoined_streaming = true;
      return result;
    });

    await scenario('Perte d’un membre etcd : le quorum permet une écriture', async () => duringOutage(['etcd1'], async () => {
      const booking = await confirmBooking(newBooking('etcd minoritaire'), { retry: true });
      return { stopped_member: 'etcd1', booking_id: booking.id, copies: await replicatedBooking(booking.id) };
    }));

    await scenario('Perte des deux répliques : aucun achat confirmé, reprise avec la même clé', async () => {
      const leader = primary(cluster());
      const replicas = pgServices.filter(service => service !== leader);
      const before = reservedCount();
      let refused;
      let refusedReplay;
      await duringOutage(replicas, async () => {
        // Le primaire reste seul. Patroni retire le standby après loop_wait mais
        // synchronous_mode_strict doit conserver une exigence synchrone bloquante.
        await sleep((Number(patroniConfig.loop_wait || 5) + 2) * 1000);
        refused = await blockedBooking('sans répliques, première demande');
        refusedReplay = await blockedBooking('sans répliques, rejeu de la même clé pendant la panne', refused.attempt);
      });
      const resolution = await resolveUncertain(refused.attempt);
      const delta = reservedCount() - before;
      assert.equal(delta, 1, 'La reprise doit consommer exactement une place');
      report.invariants.no_confirmed_write_without_synchronous_replica = true;
      report.invariants.same_key_not_confirmed_without_synchronous_replica = true;
      return { primary: leader, stopped_replicas: replicas, response_status: refused.status, request_duration_ms: refused.duration_ms, same_key_replay_during_outage: { response_status: refusedReplay.status, request_duration_ms: refusedReplay.duration_ms }, uncertain_commit_resolution: resolution, reserved_delta: delta };
    });

    await scenario('Perte du quorum etcd : aucune nouvelle écriture après expiration du bail', async () => {
      const stopped = ['etcd2', 'etcd3'];
      const before = reservedCount();
      const settleMs = (Number(patroniConfig.ttl) + Number(patroniConfig.loop_wait || 5) + Number(patroniConfig.retry_timeout || 5)) * 1000;
      assert.ok(settleMs <= 90_000, 'Bail Patroni trop long pour cette recette bornée à 120 s');
      let refused = [];
      let observedAfterMs;
      await duringOutage(stopped, async () => {
        const begin = Date.now();
        await sleep(settleMs);
        refused.push(await blockedBooking('sans quorum 1'));
        observedAfterMs = Date.now() - begin;
        refused.push(await blockedBooking('sans quorum 2'));
      });
      const resolutions = [];
      for (const request of refused) resolutions.push(await resolveUncertain(request.attempt));
      const delta = reservedCount() - before;
      assert.equal(delta, refused.length, 'Chaque clé rejouée doit consommer exactement une place');
      await replicatedBooking(baseline.id);
      report.invariants.no_write_after_quorum_lease_expiry = true;
      return { stopped_members: stopped, lease_wait_ms: settleMs, first_refusal_observed_ms: observedAfterMs, response_statuses: refused.map(attempt => attempt.status), uncertain_commit_resolutions: resolutions, reserved_delta: delta };
    });

    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    try {
      await restore([...affectedServices]);
      // Même après SIGINT, le nettoyage garde son budget pour rétablir le cluster.
      const wasInterrupted = interrupted;
      interrupted = false;
      report.final_cluster = await healthyCluster();
      if (baseline) report.final_baseline_copies = await replicatedBooking(baseline.id);
      report.invariants.final_cluster_healthy = true;
      interrupted = wasInterrupted;
    } catch (error) {
      report.status = 'failed';
      report.cleanup_error = error.message;
      report.invariants.final_cluster_healthy = false;
      process.exitCode = 1;
    }
    report.finished_at = new Date().toISOString();
    report.duration_ms = Date.now() - startedAt.getTime();
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`Rapport de recette écrit : ${reportPath}`);
    console.log(`Résultat : ${report.status}. Cluster final sain : ${report.invariants.final_cluster_healthy === true ? 'oui' : 'non'}.`);
    process.off('SIGINT', handleInterrupt);
    process.off('SIGTERM', handleInterrupt);
  }
}

await main();
