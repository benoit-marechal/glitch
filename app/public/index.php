<?php
declare(strict_types=1);
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (str_starts_with($path, '/api/') || in_array($path, ['/livez', '/readyz'], true)) {
    require dirname(__DIR__) . '/src/api.php';
    routeApi($path, $_SERVER['REQUEST_METHOD'] ?? 'GET');
}
if ($path !== '/') {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Cette adresse n’existe pas.';
    exit;
}
header('Cache-Control: no-store');
?><!doctype html>
<html lang="fr">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#08090c">
    <meta name="description" content="GLITCH · Art, Tech & Mutations. Arts immersifs, club culture, live coding, mode et contre-parole. Du 11 au 13 octobre 2027 à Paris. Festival de démonstration.">
    <title>GLITCH 2027 · Art, Tech & Mutations</title>
    <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
    <link rel="stylesheet" href="/assets/style.css">
    <script src="/assets/app.js" defer></script>
</head>
<body>
    <a href="#programme" class="skip-link">Aller au programme</a>
    <header class="site-header wrap">
        <a class="brand" href="/" aria-label="GLITCH, accueil"><span class="brand-mark" aria-hidden="true">[</span>GLITCH<span class="brand-mark" aria-hidden="true">]</span><span class="edition">2027</span></a>
        <nav aria-label="Navigation principale"><a class="universe-link" href="#univers">L’univers</a><a href="#programme">Les pass</a><button type="button" id="my-tickets" class="nav-ticket">Mes billets <span aria-hidden="true">↗</span></button></nav>
    </header>

    <main>
        <section class="hero wrap" aria-labelledby="hero-title">
            <div class="hero-copy">
                <p class="eyebrow"><span class="live-dot" aria-hidden="true"></span> 11-13 OCTOBRE 2027 · PARIS</p>
                <h1 id="hero-title"><span class="festival-name">GLITCH</span><span class="hero-subline">ART, TECH<br>&amp; MUTATIONS</span></h1>
                <p class="hero-description">Le système a besoin<br>d’un <strong>reboot.</strong></p>
                <a class="button acid" href="#programme">Viens buguer avec nous <span aria-hidden="true">↘</span></a>
                <p class="hero-note">Festival de démonstration · Paiement simulé</p>
            </div>
            <div class="hero-art">
                <img src="/assets/festival/hero-scene.jpg" alt="Scène GLITCH : un portrait numérique fragmenté au-dessus de la foule, traversé de lasers cyan et magenta" width="1024" height="559" fetchpriority="high">
                <div class="hero-stamp" aria-hidden="true"><span>SYSTEM ERROR</span><strong>PANIQUE<br>CRÉATIVE</strong><span>PARIS / 2027</span></div>
                <div class="hero-coordinate"><span>ART + TECH + MUTATIONS</span><strong>SORTEZ DU CADRE.</strong></div>
            </div>
        </section>

        <div class="ticker" aria-hidden="true"><div>SORTEZ DU CADRE <span>+</span> ERREUR DE SYSTÈME <span>+</span> PANIQUE CRÉATIVE <span>+</span> VIENS BUGUER AVEC NOUS <span>+</span> SORTEZ DU CADRE <span>+</span></div></div>

        <section id="univers" class="universe wrap" aria-labelledby="universe-title">
            <div class="section-heading"><div><p class="eyebrow">LE FESTIVAL HORS FORMAT</p><h2 id="universe-title">Cinq pôles.<br>Aucune case<span>.</span></h2></div><p class="section-intro">La création déborde.<br>On lui laisse toute la place.</p></div>
            <figure class="universe-visual"><img src="/assets/festival/univers-poles.jpg" alt="Trois affiches GLITCH pour les arts visuels et immersifs, la musique et la club culture, la mode et le design" width="1024" height="559" loading="lazy"><figcaption>ARTS VISUELS / MUSIQUE / MODE / CODE / IDÉES</figcaption></figure>
            <div class="poles-grid">
                <article class="pole pole-cyan"><span class="pole-index">01 / ARTS VISUELS &amp; IMMERSIFS</span><h3>Le futur<br>distordu.</h3><p>Génératif en live, réalité augmentée et sculptures postdigitales. Des images qui changent de dimension.</p><span class="pole-tag">L’IMAGE SORT DE L’ÉCRAN ↗</span></article>
                <article class="pole pole-pink"><span class="pole-index">02 / MUSIQUE &amp; CLUB CULTURE</span><h3>Les marges<br>électroniques.</h3><p>Ambient, IDM, hyperpop, techno industrielle et lives audiovisuels. Les sons qui déplacent les lignes.</p><span class="pole-tag">LE CORPS PREND LE RELAIS ↗</span></article>
                <article class="pole pole-lime"><span class="pole-index">03 / LE CAVEAU ALGORAVE</span><h3>Le code<br>fait du bruit.</h3><p>Du live coding en public avec CODE_WAVE, SYNTAX_ERROR et VJ_BUFFER, projets fictifs de cette programmation.</p><span class="pole-tag">CRÉATION EN TEMPS RÉEL ↗</span></article>
                <article class="pole"><span class="pole-index">04 / MODE &amp; DESIGN</span><h3>Le réel<br>se recompose.</h3><p>Phygital, upcycling et market indépendant. Matières, corps et objets cherchent leurs prochaines formes.</p><span class="pole-tag">RÉINVENTER CE QUI EXISTE ↗</span></article>
                <article class="pole"><span class="pole-index">05 / TALKS &amp; MASTERCLASSES</span><h3>La contre-<br>parole.</h3><p>IA et création indépendante, live coding, design génératif. Des échanges pour questionner les outils et ouvrir d’autres voies.</p><span class="pole-tag">PENSER HORS DU SYSTÈME ↗</span></article>
            </div>
        </section>

        <section id="programme" class="programme wrap" aria-labelledby="programme-title">
            <div class="section-heading"><div><p class="eyebrow">11 / 12 / 13 OCTOBRE</p><h2 id="programme-title">Choisis ton point<br>de rupture<span>.</span></h2></div><button id="refresh-events" type="button" class="text-button">Actualiser les places <span aria-hidden="true">↻</span></button></div>
            <div id="pending-banner" class="notice pending-notice" hidden><span>Une demande reste à vérifier. Reprends-la avec la même clé pour retrouver son résultat.</span><button type="button" id="resume-booking" class="button small">Reprendre ma demande ↗</button></div>
            <p class="programme-note">Trois pass journée. Un univers à explorer par jour. Une place par réservation, sans paiement réel.</p>
            <p id="events-message" class="notice" role="status">La programmation se connecte…</p>
            <div id="event-grid" class="event-grid" aria-busy="true"></div>
        </section>

        <section class="manifesto wrap" aria-label="L’esprit GLITCH"><span class="manifesto-star" aria-hidden="true">[!]</span><p>Erreur de système,<br><span>panique créative.</span></p><span class="manifesto-label">11-13 OCTOBRE 2027<br>PARIS · SORTEZ DU CADRE.</span></section>
        <section class="practical wrap" aria-label="Informations pratiques"><div><span>01</span><h3>Un pass, ta place.</h3><p>Un pass journée par réservation. Retrouve tes billets sur cet appareil ou conserve leur référence complète.</p></div><div><span>02</span><h3>Le festival, en démo.</h3><p>Programmation fictive inspirée du dossier GLITCH. Le paiement est simulé. Aucune carte bancaire et aucun débit.</p></div><div><span>03</span><h3>Un seul passage.</h3><p>Un billet accepté permet un seul passage. L’espace organisateur vérifie le jeton à l’entrée.</p></div></section>
    </main>

    <footer class="site-footer wrap"><a class="brand" href="/" aria-label="GLITCH, accueil"><span class="brand-mark" aria-hidden="true">[</span>GLITCH<span class="brand-mark" aria-hidden="true">]</span></a><p>Art, Tech &amp; Mutations.<br>Un festival imaginaire. Un lab bien réel.</p><div class="footer-tools"><span id="service-status" role="status">Connexion à la billetterie…</span><button id="open-admin" type="button" class="text-button">Espace organisateur ↗</button></div></footer>

    <dialog id="booking-dialog" aria-labelledby="booking-title">
        <button class="close-button" type="button" data-close aria-label="Fermer la réservation">×</button>
        <p class="eyebrow">TON ACCÈS À GLITCH</p><h2 id="booking-title">Sors du cadre.</h2>
        <div id="booking-event" class="booking-event"></div>
        <form id="booking-form">
            <label for="booking-name">Ton pseudonyme de démo</label><input id="booking-name" name="name" type="text" required maxlength="80" placeholder="Ex. Camille" autocomplete="off" aria-describedby="name-help"><p id="name-help" class="field-help">Utilise un pseudonyme fictif, pas de données personnelles.</p>
            <label for="booking-payment">Résultat du paiement simulé</label><select id="booking-payment" name="payment"><option value="accepted">Accepté · je reçois mon billet</option><option value="declined">Refusé · je teste un échec</option></select>
            <div class="payment-info"><span aria-hidden="true">◎</span><p>Mode démonstration<br><strong>Aucune carte. Aucun argent débité.</strong></p></div>
            <p id="booking-message" class="form-message" role="status"></p>
            <button id="booking-submit" type="submit" class="button acid wide">Confirmer mon pass <span aria-hidden="true">↗</span></button>
        </form>
    </dialog>

    <dialog id="ticket-dialog" class="ticket-dialog" aria-labelledby="ticket-heading"><button class="close-button" type="button" data-close aria-label="Fermer le billet">×</button><div id="ticket-content"></div></dialog>
    <dialog id="tickets-dialog" aria-labelledby="tickets-title"><button class="close-button" type="button" data-close aria-label="Fermer mes billets">×</button><p class="eyebrow">TES ACCÈS À GLITCH</p><h2 id="tickets-title">Mes billets.</h2><p class="field-help">Les références sont conservées uniquement sur cet appareil.</p><div id="saved-tickets" class="saved-tickets"></div><form id="lookup-form" class="lookup-form"><label for="booking-reference">Retrouver un billet par sa référence complète</label><input id="booking-reference" type="text" required placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off"><button class="button small" type="submit">Retrouver mon billet ↗</button><p id="lookup-message" class="form-message" role="status"></p></form></dialog>
    <dialog id="admin-dialog" aria-labelledby="admin-title"><button class="close-button" type="button" data-close aria-label="Fermer l’espace organisateur">×</button><p class="eyebrow">CÔTÉ COULISSES</p><h2 id="admin-title">Contrôle d’entrée.</h2><p class="field-help">Le premier contrôle valide l’entrée. Un second passage est refusé.</p><form id="admin-form"><label for="admin-token">Jeton organisateur</label><input id="admin-token" type="password" required autocomplete="off" placeholder="Jeton fourni au démarrage du lab"><label for="ticket-token">Jeton du billet</label><textarea id="ticket-token" required rows="3" maxlength="64" placeholder="Les 64 caractères figurant sur le billet" spellcheck="false"></textarea><button class="button acid wide" type="submit">Vérifier et valider l’entrée ↗</button><p id="admin-message" class="form-message" role="status"></p></form></dialog>
    <div id="toast" class="toast" role="status" hidden></div>
</body>
</html>
