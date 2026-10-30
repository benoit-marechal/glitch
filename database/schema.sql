BEGIN;

CREATE TABLE IF NOT EXISTS events (
    id integer PRIMARY KEY,
    title text NOT NULL,
    artist text NOT NULL,
    starts_at timestamptz NOT NULL,
    stage text NOT NULL,
    genre text NOT NULL,
    capacity integer NOT NULL CHECK (capacity > 0),
    reserved_count integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0 AND reserved_count <= capacity),
    price_cents integer NOT NULL CHECK (price_cents > 0)
);

CREATE TABLE IF NOT EXISTS bookings (
    id uuid PRIMARY KEY,
    event_id integer NOT NULL REFERENCES events(id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    payment_status text NOT NULL CHECK (payment_status IN ('accepted', 'declined')),
    amount_cents integer NOT NULL CHECK (amount_cents > 0),
    ticket_token text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    checked_at timestamptz,
    CHECK ((payment_status = 'accepted' AND ticket_token IS NOT NULL)
        OR (payment_status = 'declined' AND ticket_token IS NULL AND checked_at IS NULL)),
    CHECK (ticket_token IS NULL OR ticket_token ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS bookings_event_id_idx ON bookings(event_id);

CREATE TABLE IF NOT EXISTS booking_requests (
    idempotency_key text PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    booking_id uuid UNIQUE REFERENCES bookings(id),
    response_status integer CHECK (response_status IN (201, 402, 409)),
    response_payload jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((response_status IS NULL AND response_payload IS NULL)
        OR (response_status IS NOT NULL AND response_payload IS NOT NULL))
);

-- L'habillage GLITCH reprend le PDF fourni. Année, horaires, prix et jauges restent des paramètres de simulation.
INSERT INTO events (id, title, artist, starts_at, stage, genre, capacity, price_cents) VALUES
    (1, 'Pass 11 octobre', 'LE FUTUR DISTORDU', '2027-10-11 18:00:00+02', 'Paris · Espaces immersifs', 'Arts visuels · Live AV', 200, 3900),
    (2, 'Pass 12 octobre', 'LE CAVEAU ALGORAVE', '2027-10-12 18:30:00+02', 'Paris · Caveau Algorave', 'Live coding · IDM', 30, 2900),
    (3, 'Pass 13 octobre', 'LES MARGES ÉLECTRONIQUES', '2027-10-13 19:00:00+02', 'Paris · Club GLITCH', 'Club culture · Hyperpop', 10, 3500)
-- Le bootstrap actualise seulement la programmation : aucun compteur, tarif existant ou billet n'est réinitialisé.
ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    artist = EXCLUDED.artist,
    starts_at = EXCLUDED.starts_at,
    stage = EXCLUDED.stage,
    genre = EXCLUDED.genre;

COMMIT;
