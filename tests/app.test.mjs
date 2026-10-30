import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8088';
const adminPath = process.env.ADMIN_TOKEN_FILE ?? new URL('../.secrets/admin_token', import.meta.url);

// La recette appelle le vrai portail avec une échéance bornée. Sans ce client,
// chaque scénario devrait réimplémenter la lecture JSON et pourrait rester bloqué.
async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    signal: AbortSignal.timeout(12_000),
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json();
  return { status: response.status, body, headers: response.headers };
}

// Les scénarios métier passent par cette soumission réelle. La clé fournie permet
// de tester les reprises, qui seraient autrement confondues avec de nouveaux achats.
async function book(payload, key = randomUUID()) {
  return request('/api/bookings', {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(payload),
  });
}

// La lecture avant/après donne le stock réellement observé par les scénarios.
// Sans elle, une base déjà utilisée rendrait les assertions de capacité trompeuses.
async function events() {
  const result = await request('/api/events');
  assert.equal(result.status, 200);
  return result.body.events;
}

// L'identifiant doit rester dans le domaine SQL avant de joindre la base.
// Sans cette borne, une simple saisie trop grande devient une fausse panne 503.
test('un identifiant hors plage SQL est refusé avant la connexion', async () => {
  const result = await book({ event_id: 2_147_483_648, name: 'Hors plage', payment: 'accepted' });
  assert.equal(result.status, 422);
});

// Cette suite séquentielle réserve les événements 1 et 2 à la recette métier.
// L'événement 3 reste disponible pour la recette HA et aucun historique n'est effacé.
test('billetterie réelle : contrats, concurrence et contrôle', async (t) => {
  let confirmed;
  let confirmedPayload;
  let confirmedKey;

  // Le premier appel rend explicite l'absence du service pendant la phase rouge.
  // Sans ce contrôle, les échecs suivants pourraient masquer un simple démarrage manquant.
  await t.test('le processus et la base sont prêts', async () => {
    const live = await request('/livez');
    assert.equal(live.status, 200);
    assert.equal(live.body.status, 'ok');
    const ready = await request('/readyz');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, 'ready');
    const status = await request('/api/status');
    assert.equal(status.status, 200);
    assert.match(status.body.node, /^web[12]$/);
    assert.equal(status.body.db.in_recovery, false);
    assert.equal(typeof status.body.db.server_addr, 'string');
  });

  await t.test('les trois concerts exposent un stock cohérent', async () => {
    const concerts = await events();
    assert.equal(concerts.length, 3);
    for (const event of concerts) {
      assert.equal(typeof event.id, 'number');
      assert.equal(typeof event.title, 'string');
      assert.equal(typeof event.artist, 'string');
      assert.ok(Number.isFinite(Date.parse(event.starts_at)));
      assert.ok(event.remaining >= 0 && event.remaining <= event.capacity);
      assert.ok(Number.isInteger(event.price_cents) && event.price_cents > 0);
    }
  });

  await t.test('les requêtes mal formées ne créent pas de réservation', async () => {
    const before = await events();
    const malformed = await request('/api/bookings', {
      method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: '{broken',
    });
    assert.equal(malformed.status, 422);
    const oversized = await request('/api/bookings', {
      method: 'POST', headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ event_id: 1, name: 'x'.repeat(20_000), payment: 'accepted' }),
    });
    assert.equal(oversized.status, 422);
    for (const payload of [
      { event_id: '1', name: 'Test', payment: 'accepted' },
      { event_id: 1, name: '', payment: 'accepted' },
      { event_id: 1, name: 'Test', payment: 'unknown' },
      { event_id: 999_999, name: 'Test', payment: 'accepted' },
    ]) {
      assert.equal((await book(payload)).status, 422);
    }
    const missingKey = await request('/api/bookings', {
      method: 'POST', body: JSON.stringify({ event_id: 1, name: 'Test', payment: 'accepted' }),
    });
    assert.equal(missingKey.status, 422);
    assert.deepEqual(await events(), before);
  });

  await t.test('un paiement refusé ne consomme pas de place ni de jeton', async () => {
    const before = (await events()).find((event) => event.id === 1).remaining;
    const key = randomUUID();
    const payload = { event_id: 1, name: 'Démo refus', payment: 'declined' };
    const refused = await book(payload, key);
    assert.equal(refused.status, 402);
    assert.equal(refused.body.booking.payment_status, 'declined');
    assert.equal(refused.body.booking.ticket_token, null);
    const replay = await book(payload, key);
    assert.equal(replay.status, 402);
    assert.equal(replay.body.booking.id, refused.body.booking.id);
    assert.equal((await events()).find((event) => event.id === 1).remaining, before);
  });

  await t.test('une réservation acceptée consomme exactement une place', async () => {
    const before = (await events()).find((event) => event.id === 1).remaining;
    assert.ok(before > 0, 'L’événement 1 doit conserver une place pour cette recette.');
    confirmedPayload = { event_id: 1, name: 'Camille démo', payment: 'accepted' };
    confirmedKey = randomUUID();
    const created = await book(confirmedPayload, confirmedKey);
    assert.equal(created.status, 201);
    confirmed = created.body.booking;
    assert.equal(confirmed.event_id, 1);
    assert.equal(confirmed.payment_status, 'accepted');
    assert.match(confirmed.id, /^[a-f0-9-]{36}$/);
    assert.match(confirmed.ticket_token, /^[a-f0-9]{64}$/);
    assert.equal((await events()).find((event) => event.id === 1).remaining, before - 1);
  });

  await t.test('le rejeu conserve le billet et refuse une autre charge utile', async () => {
    assert.ok(confirmed);
    const before = (await events()).find((event) => event.id === 1).remaining;
    const replay = await book(confirmedPayload, confirmedKey);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.booking, confirmed);
    assert.equal((await book({ ...confirmedPayload, name: 'Autre pseudo' }, confirmedKey)).status, 409);
    assert.equal((await events()).find((event) => event.id === 1).remaining, before);
    const read = await request(`/api/bookings/${confirmed.id}`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.booking, confirmed);
    assert.equal((await request(`/api/bookings/${randomUUID()}`)).status, 404);
  });

  await t.test('douze demandes simultanées avec la même clé donnent un seul billet', async () => {
    const before = (await events()).find((event) => event.id === 1).remaining;
    assert.ok(before > 0);
    const key = randomUUID();
    const payload = { event_id: 1, name: 'Même achat parallèle', payment: 'accepted' };
    const results = await Promise.all(Array.from({ length: 12 }, () => book(payload, key)));
    assert.equal(results.filter((result) => result.status === 201).length, 1);
    assert.equal(results.filter((result) => result.status === 200).length, 11);
    assert.equal(new Set(results.map((result) => result.body.booking.id)).size, 1);
    assert.equal((await events()).find((event) => event.id === 1).remaining, before - 1);
  });

  await t.test('une même clé soumise avec deux contenus concurrents ne valide qu’un achat', async () => {
    const before = (await events()).find((event) => event.id === 1).remaining;
    assert.ok(before > 0);
    const key = randomUUID();
    const results = await Promise.all([
      book({ event_id: 1, name: 'Conflit A', payment: 'accepted' }, key),
      book({ event_id: 1, name: 'Conflit B', payment: 'accepted' }, key),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    assert.equal(results.find((result) => result.status === 409).body.error, 'idempotency_conflict');
    assert.equal((await events()).find((event) => event.id === 1).remaining, before - 1);
  });

  await t.test('les dernières places ne peuvent pas être survendues', async (subtest) => {
    const before = (await events()).find((event) => event.id === 2).remaining;
    if (before === 0) {
      subtest.skip('Le concert 2 a déjà été épuisé. La concurrence doit être recettée sur un volume neuf pour observer de nouvelles ventes.');
      return;
    }
    const results = await Promise.all(Array.from({ length: before + 8 }, (_, index) => book({
      event_id: 2, name: `Dernière place ${index}`, payment: 'accepted',
    })));
    assert.equal(results.filter((result) => result.status === 201).length, before);
    assert.equal(results.filter((result) => result.status === 409).length, 8);
    assert.equal((await events()).find((event) => event.id === 2).remaining, 0);
    assert.equal(new Set(results.filter((result) => result.status === 201).map((result) => result.body.booking.id)).size, before);
  });

  await t.test('seul l’organisateur contrôle le billet et le second passage est refusé', async () => {
    assert.ok(confirmed);
    const path = `/api/tickets/${confirmed.ticket_token}/check`;
    assert.equal((await request(path, { method: 'POST' })).status, 401);
    assert.equal((await request(path, { method: 'POST', headers: { 'X-Admin-Token': 'incorrect' } })).status, 401);
    const token = (await readFile(adminPath, 'utf8')).trim();
    const simultaneous = await Promise.all([
      request(path, { method: 'POST', headers: { 'X-Admin-Token': token } }),
      request(path, { method: 'POST', headers: { 'X-Admin-Token': token } }),
    ]);
    assert.deepEqual(simultaneous.map((result) => result.status).sort(), [200, 409]);
    assert.ok(simultaneous.find((result) => result.status === 200).body.booking.checked_at);
    const second = await request(path, { method: 'POST', headers: { 'X-Admin-Token': token } });
    assert.equal(second.status, 409);
    assert.equal((await request(`/api/tickets/${'0'.repeat(64)}/check`, {
      method: 'POST', headers: { 'X-Admin-Token': token },
    })).status, 404);
  });
});
