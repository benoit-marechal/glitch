<?php
declare(strict_types=1);

final class ApiError extends RuntimeException
{
    // Le routeur transporte un refus métier jusqu'au gestionnaire commun. Sans
    // ce statut explicite, une erreur de saisie serait confondue avec une panne SQL.
    public function __construct(public readonly int $status, string $message, public readonly string $errorCode)
    {
        parent::__construct($message);
    }
}

// Chaque réponse API identifie le frontal réellement sollicité et désactive le
// cache. Le routeur l'appelle en sortie, sinon des billets pourraient être mis en cache.
function jsonResponse(int $status, array $payload): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    $payload['node'] = getenv('APP_NODE') ?: 'web-local';
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// Les connexions et contrôles lisent leurs secrets au moment de l'appel. Sans
// cette lecture bornée, un fichier manquant provoquerait une erreur divulguée au client.
function secretFile(string $variable): string
{
    $path = getenv($variable);
    if (!$path || !is_readable($path)) {
        throw new RuntimeException('Configuration secrète indisponible.');
    }
    $value = trim((string) file_get_contents($path, false, null, 0, 1025));
    if ($value === '' || strlen($value) > 1024) {
        throw new RuntimeException('Configuration secrète invalide.');
    }
    return $value;
}

// Toute route SQL ouvre une connexion non persistante au proxy du primaire.
// Les délais bornés rendent une panne visible en 503 au lieu de bloquer les frontaux.
function database(): PDO
{
    $host = getenv('DB_HOST') ?: 'sql1';
    $port = getenv('DB_PORT') ?: '5432';
    $name = getenv('DB_NAME') ?: 'festival';
    $user = getenv('DB_USER') ?: 'festival_app';
    if (!preg_match('/^[a-zA-Z0-9_.-]+$/D', $host) || !preg_match('/^[0-9]{1,5}$/D', $port)
        || !preg_match('/^[a-zA-Z0-9_]+$/D', $name) || !preg_match('/^[a-zA-Z0-9_]+$/D', $user)) {
        throw new RuntimeException('Configuration SQL invalide.');
    }
    $pdo = new PDO("pgsql:host={$host};port={$port};dbname={$name};connect_timeout=2", $user, secretFile('DB_PASSWORD_FILE'), [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_PERSISTENT => false,
    ]);
    $pdo->exec("SET statement_timeout = '4s'; SET lock_timeout = '3s'; SET idle_in_transaction_session_timeout = '6s'; SET TIME ZONE 'UTC'");
    return $pdo;
}

// Le formulaire de réservation appelle ce parseur avant toute écriture. Sans
// cette validation de taille, de type et de JSON, le contrat accepterait des entrées ambiguës.
function bookingInput(): array
{
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 16384) {
        throw new ApiError(422, 'La demande est trop volumineuse.', 'invalid_input');
    }
    if (!preg_match('/^application\/json(?:\s*;|$)/i', $_SERVER['CONTENT_TYPE'] ?? '')) {
        throw new ApiError(422, 'Envoyez un objet JSON.', 'invalid_input');
    }
    $raw = (string) file_get_contents('php://input', false, null, 0, 16385);
    if (strlen($raw) > 16384) {
        throw new ApiError(422, 'La demande est trop volumineuse.', 'invalid_input');
    }
    try {
        $input = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        throw new ApiError(422, 'Le JSON est invalide.', 'invalid_input');
    }
    if (!is_array($input) || array_is_list($input) || count($input) !== 3
        || !isset($input['event_id'], $input['name'], $input['payment'])
        || !is_int($input['event_id']) || $input['event_id'] < 1 || $input['event_id'] > 2147483647
        || !is_string($input['name']) || !is_string($input['payment'])
        || !in_array($input['payment'], ['accepted', 'declined'], true)) {
        throw new ApiError(422, 'Choisissez un concert, un pseudonyme et un résultat de paiement.', 'invalid_input');
    }
    $input['name'] = trim($input['name']);
    if (!preg_match('/^.{1,80}$/usD', $input['name']) || preg_match('/[\p{C}]/u', $input['name'])) {
        throw new ApiError(422, 'Le pseudonyme doit contenir de 1 à 80 caractères lisibles.', 'invalid_input');
    }
    $key = $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? '';
    if (!preg_match('/^[a-zA-Z0-9._:-]{8,128}$/D', $key)) {
        throw new ApiError(422, 'Une clé Idempotency-Key de 8 à 128 caractères est obligatoire.', 'invalid_idempotency_key');
    }
    return ['event_id' => $input['event_id'], 'name' => $input['name'], 'payment' => $input['payment'], 'key' => $key];
}

// La création d'un achat appelle ce générateur UUID v4 imprévisible. Sans lui,
// une référence séquentielle rendrait les billets des autres visiteurs devinables.
function bookingId(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    $hex = bin2hex($bytes);
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20);
}

// Les routes de consultation et de contrôle lisent la même projection du billet.
// Sans cette conversion, PDO exposerait certains entiers en chaînes selon sa version.
function findBooking(PDO $pdo, string $id): ?array
{
    $query = $pdo->prepare('SELECT b.id, b.event_id, b.name, b.payment_status, b.amount_cents, b.ticket_token,
        b.created_at, b.checked_at, e.title, e.artist, e.starts_at, e.stage
        FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.id = :id');
    $query->execute(['id' => $id]);
    $booking = $query->fetch();
    if (!$booking) {
        return null;
    }
    $booking['event_id'] = (int) $booking['event_id'];
    $booking['amount_cents'] = (int) $booking['amount_cents'];
    return $booking;
}

// Chaque transaction passe ici juste avant son commit. PostgreSQL peut annuler
// l'attente SyncRep avec un simple WARNING tout en confirmant COMMIT au pilote.
// Sans cette désactivation locale, un timeout SQL pourrait produire un faux succès.
// Le proxy SQL borne cette attente par fermeture de transport après 6 secondes :
// le client reçoit alors 503 et reprend sa clé pour résoudre le résultat incertain.
function commitDatabase(PDO $pdo): void
{
    $pdo->exec('SET LOCAL statement_timeout = 0');
    $pdo->commit();
}

// POST /api/bookings sérialise une même clé puis verrouille le stock du concert.
// Sans cette transaction unique, des clics simultanés créeraient des doublons ou une survente.
function createBooking(PDO $pdo, array $input): array
{
    $canonical = ['event_id' => $input['event_id'], 'name' => $input['name'], 'payment' => $input['payment']];
    $hash = hash('sha256', json_encode($canonical, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
    $pdo->beginTransaction();
    try {
        // L'unicité attend la transaction concurrente. La lecture suivante en READ COMMITTED
        // voit son résultat validé. Tous ces verrous disparaissent au commit ou rollback.
        $claim = $pdo->prepare('INSERT INTO booking_requests (idempotency_key, request_hash)
            VALUES (:key, :hash) ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key');
        $claim->execute(['key' => $input['key'], 'hash' => $hash]);
        $fresh = $claim->fetchColumn() !== false;
        $read = $pdo->prepare('SELECT request_hash, response_status, response_payload FROM booking_requests
            WHERE idempotency_key = :key FOR UPDATE');
        $read->execute(['key' => $input['key']]);
        $request = $read->fetch();
        if (!$request || !hash_equals($request['request_hash'], $hash)) {
            throw new ApiError(409, 'Cette clé identifie déjà une autre demande. Reprenez la clé de votre achat initial.', 'idempotency_conflict');
        }
        if (!$fresh) {
            if (!$request['response_payload']) {
                throw new RuntimeException('Demande incomplète.');
            }
            $payload = json_decode($request['response_payload'], true, 32, JSON_THROW_ON_ERROR);
            $status = (int) $request['response_status'];
            commitDatabase($pdo);
            return [$status === 201 ? 200 : $status, $payload];
        }

        $eventQuery = $pdo->prepare('SELECT * FROM events WHERE id = :id FOR UPDATE');
        $eventQuery->execute(['id' => $input['event_id']]);
        $event = $eventQuery->fetch();
        if (!$event) {
            throw new ApiError(422, 'Ce concert n’existe pas.', 'unknown_event');
        }
        $id = null;
        if ($input['payment'] === 'accepted' && (int) $event['reserved_count'] >= (int) $event['capacity']) {
            $status = 409;
            $payload = ['error' => 'sold_out', 'message' => 'Ce concert est complet. Découvrez les autres scènes.'];
        } else {
            $id = bookingId();
            $token = $input['payment'] === 'accepted' ? bin2hex(random_bytes(32)) : null;
            if ($input['payment'] === 'accepted') {
                $stock = $pdo->prepare('UPDATE events SET reserved_count = reserved_count + 1 WHERE id = :id');
                $stock->execute(['id' => $input['event_id']]);
            }
            $insert = $pdo->prepare('INSERT INTO bookings (id, event_id, name, payment_status, amount_cents, ticket_token)
                VALUES (:id, :event, :name, :payment, :amount, :token)');
            $insert->execute(['id' => $id, 'event' => $input['event_id'], 'name' => $input['name'],
                'payment' => $input['payment'], 'amount' => $event['price_cents'], 'token' => $token]);
            $payload = ['booking' => findBooking($pdo, $id)];
            $status = $input['payment'] === 'accepted' ? 201 : 402;
            if ($status === 402) {
                $payload['error'] = 'payment_declined';
                $payload['message'] = 'Paiement simulé refusé. Aucune place n’a été consommée.';
            }
        }
        $save = $pdo->prepare('UPDATE booking_requests SET booking_id = :booking,
            response_status = :status, response_payload = CAST(:payload AS jsonb) WHERE idempotency_key = :key');
        $save->execute(['booking' => $id, 'status' => $status,
            'payload' => json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), 'key' => $input['key']]);
        // Un échec réseau pendant commit ne dit pas si l'écriture est validée.
        // Le client reçoit 503 et doit rejouer strictement la même clé pour lever ce doute.
        commitDatabase($pdo);
        return [$status, $payload];
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            try {
                $pdo->rollBack();
            } catch (Throwable) {
                // Une connexion déjà perdue libère ses verrous côté PostgreSQL.
            }
        }
        throw $error;
    }
}

// La route organisateur authentifie avant tout accès SQL et marque le billet sous
// verrou. Sans ce contrôle atomique, deux lecteurs pourraient accepter le même passage.
function checkTicket(PDO $pdo, string $token): array
{
    $pdo->beginTransaction();
    try {
        $read = $pdo->prepare("SELECT id, checked_at FROM bookings WHERE ticket_token = :token
            AND payment_status = 'accepted' FOR UPDATE");
        $read->execute(['token' => $token]);
        $booking = $read->fetch();
        if (!$booking) {
            throw new ApiError(404, 'Billet introuvable.', 'ticket_not_found');
        }
        if ($booking['checked_at'] !== null) {
            throw new ApiError(409, 'Ce billet a déjà été contrôlé.', 'ticket_already_checked');
        }
        $update = $pdo->prepare('UPDATE bookings SET checked_at = clock_timestamp() WHERE id = :id');
        $update->execute(['id' => $booking['id']]);
        $result = findBooking($pdo, $booking['id']);
        commitDatabase($pdo);
        return ['booking' => $result, 'message' => 'Billet valide. Bon concert !'];
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            try {
                $pdo->rollBack();
            } catch (Throwable) {
                // Le refus doit rester visible même si la connexion vient de tomber.
            }
        }
        throw $error;
    }
}

// L'entrée HTTP appelle ce routeur pour chaque API. Il sépare erreurs métier et
// indisponibilité sans divulguer SQL ni secrets, sinon les clients ne sauraient pas rejouer.
function routeApi(string $path, string $method): never
{
    try {
        if ($path === '/livez' && $method === 'GET') {
            jsonResponse(200, ['status' => 'ok']);
        }
        if (preg_match('#^/api/tickets/([a-f0-9]{64})/check$#D', $path, $ticketMatch) && $method === 'POST') {
            $expected = secretFile('ADMIN_TOKEN_FILE');
            if (!hash_equals($expected, $_SERVER['HTTP_X_ADMIN_TOKEN'] ?? '')) {
                throw new ApiError(401, 'Le jeton organisateur est incorrect.', 'unauthorized');
            }
            jsonResponse(200, checkTicket(database(), $ticketMatch[1]));
        }
        if ($path === '/api/bookings' && $method === 'POST') {
            $input = bookingInput();
            [$status, $payload] = createBooking(database(), $input);
            jsonResponse($status, $payload);
        }
        if ($path === '/readyz' && $method === 'GET') {
            $pdo = database();
            $ready = $pdo->query("SELECT CASE WHEN NOT pg_is_in_recovery()
                AND current_setting('transaction_read_only') = 'off' THEN 1 ELSE 0 END")->fetchColumn();
            if ((int) $ready !== 1) {
                throw new RuntimeException('Primaire indisponible.');
            }
            jsonResponse(200, ['status' => 'ready']);
        }
        if ($path === '/api/status' && $method === 'GET') {
            $info = database()->query("SELECT inet_server_addr()::text AS server_addr,
                pg_is_in_recovery() AS in_recovery, current_setting('server_version') AS server_version,
                current_database() AS database")->fetch();
            $info['in_recovery'] = in_array($info['in_recovery'], [true, 1, '1', 't'], true);
            jsonResponse(200, ['status' => 'ok', 'db' => $info]);
        }
        if ($path === '/api/events' && $method === 'GET') {
            $events = database()->query('SELECT id, title, artist, starts_at, stage, genre,
                capacity, capacity - reserved_count AS remaining, price_cents FROM events ORDER BY starts_at')->fetchAll();
            foreach ($events as &$event) {
                foreach (['id', 'capacity', 'remaining', 'price_cents'] as $column) {
                    $event[$column] = (int) $event[$column];
                }
            }
            unset($event);
            jsonResponse(200, ['events' => $events]);
        }
        if (preg_match('#^/api/bookings/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$#D', $path, $match)
            && $method === 'GET') {
            $booking = findBooking(database(), $match[1]);
            if (!$booking) {
                throw new ApiError(404, 'Réservation introuvable.', 'booking_not_found');
            }
            jsonResponse(200, ['booking' => $booking]);
        }
        throw new ApiError(404, 'Cette adresse n’existe pas.', 'not_found');
    } catch (ApiError $error) {
        jsonResponse($error->status, ['error' => $error->errorCode, 'message' => $error->getMessage()]);
    } catch (Throwable $error) {
        // Le journal ne contient ni requête, ni paramètres, ni message PDO (hôte et secret possibles).
        error_log('billeterie: requête indisponible (' . get_class($error) . ')');
        header('Retry-After: 2');
        jsonResponse(503, ['error' => 'database_unavailable',
            'message' => 'La billetterie reprend son souffle. Réessaie avec la même demande et la même clé.',
            'retry_same_key' => true]);
    }
}
