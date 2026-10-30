'use strict';

const state = { events: [], selected: null, pending: null, busy: false };
const eventArtwork = {
  1: { file: 'univers-poles.svg', crop: 'poster-arts', alt: 'Illustration des arts visuels GLITCH : sphère générative et anneaux cyan' },
  2: { file: 'caveau-algorave.svg', crop: 'poster-code', alt: 'Illustration du Caveau Algorave : scène de live coding et lumières vertes' },
  3: { file: 'univers-poles.svg', crop: 'poster-club', alt: 'Illustration de la musique GLITCH : scène électronique et foule sous des faisceaux magenta' },
};
// Les clés resonance.pending et resonance.tickets sont conservées de l'ancienne
// identité pour préserver les billets et la clé des demandes au résultat incertain.
const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const dateLabel = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
const timeLabel = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
const dayLabel = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
const bookingDialog = document.querySelector('#booking-dialog');
const bookingForm = document.querySelector('#booking-form');
const nameInput = document.querySelector('#booking-name');
const paymentInput = document.querySelector('#booking-payment');
const submitButton = document.querySelector('#booking-submit');
const bookingMessage = document.querySelector('#booking-message');
let toastTimer;

// Les rendus de cartes et de billets échappent chaque valeur reçue de l'API.
// Sans cette frontière, un pseudonyme HTML deviendrait du contenu actif dans la page.
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

// L'interface lit seulement ses références et la demande en cours. Appelée au
// démarrage et pour les billets, cette lecture tolère un stockage navigateur désactivé.
function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

// Les actions conservent leurs références localement quand c'est possible.
// Sans ce garde-fou, un navigateur privé pourrait interrompre un achat pourtant confirmé.
function writeStorage(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Le billet reste consultable par sa référence complète affichée à l'écran.
  }
}

// Tous les boutons réseau utilisent ce client sans reprise automatique.
// Il borne l'attente, sinon une panne empêcherait le visiteur de reprendre sa demande.
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(11_000),
  });
  const body = await response.json();
  return { status: response.status, body };
}

// Les actions brèves annoncent leur résultat hors des fenêtres. Sans ce retour,
// une copie de référence ou une actualisation resterait invisible au visiteur.
function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 4000);
}

// La navigation ouvre une seule fenêtre modale à la fois. Sans cette centralisation,
// les vues billet et réservation pourraient se superposer et perdre le focus clavier.
function openDialog(dialog) {
  document.querySelectorAll('dialog[open]').forEach((opened) => opened.close());
  dialog.showModal();
}

// Le bandeau rappelle une demande dont le résultat réseau reste incertain.
// Chaque soumission l'actualise, sinon un nouveau clic pourrait lancer un autre achat.
function renderPending() {
  document.querySelector('#pending-banner').hidden = !state.pending;
  writeStorage('resonance.pending', state.pending);
}

// L'accueil transforme le stock réel en cartes réservables. Sans ce rendu après
// achat ou actualisation, le visiteur continuerait à voir un stock déjà consommé.
function renderEvents() {
  const grid = document.querySelector('#event-grid');
  grid.innerHTML = state.events.map((event) => {
    const soldOut = event.remaining === 0;
    const low = event.remaining > 0 && event.remaining <= 10;
    const stock = soldOut ? 'Complet · explore un autre jour' : low ? `Plus que ${event.remaining} place${event.remaining > 1 ? 's' : ''} !` : `${event.remaining} places pour sortir du cadre`;
    const artwork = eventArtwork[event.id] ?? { file: 'hero-scene.svg', crop: '', alt: 'Scène du festival GLITCH' };
    return `<article class="event-card"><div class="event-art"><img class="${artwork.crop}" src="/assets/festival/${artwork.file}" width="1024" height="559" alt="${escapeHTML(artwork.alt)}" loading="lazy"><span class="day-badge">${escapeHTML(dayLabel.format(new Date(event.starts_at)).toUpperCase())}</span></div><span class="genre">${escapeHTML(event.genre)}</span><h3>${escapeHTML(event.title)}</h3><p class="event-theme">${escapeHTML(event.artist)}</p><p class="event-info"><span>Dès ${escapeHTML(timeLabel.format(new Date(event.starts_at)))}</span><span>${escapeHTML(event.stage)}</span></p><div class="event-bottom"><div class="price">${escapeHTML(money.format(event.price_cents / 100))}<small>pass journée · 1 personne</small></div><button class="reserve-button" type="button" data-event-id="${event.id}" ${soldOut ? 'disabled' : ''}>${soldOut ? 'Complet' : 'Mon pass'} <span aria-hidden="true">↗</span></button></div><p class="stock ${soldOut ? 'empty' : low ? 'low' : ''}">${escapeHTML(stock)}</p></article>`;
  }).join('');
  grid.querySelectorAll('[data-event-id]').forEach((button) => button.addEventListener('click', () => openBooking(Number(button.dataset.eventId))));
}

// L'accueil et le bouton d'actualisation relisent la disponibilité du primaire.
// Sans gestion d'erreur, une panne remplacerait les cartes par une page sans explication.
async function loadEvents() {
  const message = document.querySelector('#events-message');
  const grid = document.querySelector('#event-grid');
  grid.setAttribute('aria-busy', 'true');
  try {
    const result = await api('/api/events');
    if (result.status !== 200) throw new Error('unavailable');
    state.events = result.body.events;
    renderEvents();
    message.hidden = true;
  } catch {
    message.textContent = 'La billetterie est momentanément indisponible. Actualise les places dans quelques instants.';
    message.hidden = false;
  } finally {
    grid.setAttribute('aria-busy', 'false');
  }
}

// L'accueil et les achats affichent le frontal effectivement joint. Sans cet
// indicateur discret, la démonstration ne permettrait pas de voir son alternance.
async function loadStatus() {
  const element = document.querySelector('#service-status');
  try {
    const result = await api('/api/status');
    element.textContent = result.status === 200 ? `Billetterie en ligne · ${result.body.node}` : 'Billetterie en reprise';
  } catch {
    element.textContent = 'Billetterie en reprise';
  }
}

// Le bouton réserver restaure aussi toute demande incertaine avant un nouvel achat.
// Sans cette priorité, une nouvelle clé pourrait créer une seconde place après un délai réseau.
function openBooking(eventId) {
  const pending = state.pending;
  const event = state.events.find((item) => item.id === (pending ? pending.payload.event_id : eventId));
  if (!event) {
    toast('Actualise les pass pour retrouver cette journée.');
    return;
  }
  state.selected = event;
  document.querySelector('#booking-title').textContent = pending ? 'Retrouve ta demande.' : 'Sors du cadre.';
  document.querySelector('#booking-event').innerHTML = `<strong>${escapeHTML(event.title)}</strong><p>${escapeHTML(event.artist)}<br>${escapeHTML(dateLabel.format(new Date(event.starts_at)))} dès ${escapeHTML(timeLabel.format(new Date(event.starts_at)))}<br>${escapeHTML(event.stage)} · ${escapeHTML(money.format(event.price_cents / 100))} · 1 personne</p>`;
  nameInput.value = pending ? pending.payload.name : '';
  paymentInput.value = pending ? pending.payload.payment : 'accepted';
  nameInput.disabled = Boolean(pending);
  paymentInput.disabled = Boolean(pending);
  submitButton.disabled = false;
  submitButton.textContent = pending ? 'Vérifier ma demande initiale ↗' : `Confirmer mon pass · ${money.format(event.price_cents / 100)} ↗`;
  bookingMessage.className = 'form-message';
  bookingMessage.textContent = pending ? 'On reprend exactement la même demande. Une place déjà confirmée ne sera pas achetée une seconde fois.' : '';
  openDialog(bookingDialog);
}

// Le formulaire sauvegarde une clé avant d'envoyer et la conserve en cas de doute.
// Sans ce cycle, une réponse perdue au commit pourrait provoquer un double achat.
async function submitBooking(event) {
  event.preventDefault();
  if (state.busy || !state.selected) return;
  if (!state.pending && !bookingForm.reportValidity()) return;
  state.busy = true;
  if (!state.pending) {
    state.pending = {
      key: crypto.randomUUID(),
      payload: { event_id: state.selected.id, name: nameInput.value.trim(), payment: paymentInput.value },
    };
  }
  renderPending();
  nameInput.disabled = true;
  paymentInput.disabled = true;
  submitButton.disabled = true;
  submitButton.textContent = 'On prépare ton pass…';
  bookingMessage.textContent = '';
  try {
    const result = await api('/api/bookings', {
      method: 'POST', headers: { 'Idempotency-Key': state.pending.key }, body: JSON.stringify(state.pending.payload),
    });
    if (result.status >= 500) throw new Error('uncertain');
    state.pending = null;
    renderPending();
    if (result.status === 200 || result.status === 201) {
      rememberTicket(result.body.booking);
      renderTicket(result.body.booking);
      openDialog(document.querySelector('#ticket-dialog'));
      toast(result.status === 201 ? 'Ton pass est confirmé. Rendez-vous à GLITCH !' : 'Ta réservation est retrouvée. Une seule place a été achetée.');
    } else {
      bookingMessage.textContent = result.body.error === 'sold_out' ? 'Ce pass journée est complet. Explore les autres jours de GLITCH.' : result.body.message ?? 'Cette demande n’a pas pu aboutir.';
      nameInput.disabled = false;
      paymentInput.disabled = false;
      if (result.status === 402) {
        paymentInput.value = 'accepted';
        submitButton.textContent = 'Réessayer avec un paiement accepté ↗';
      } else if (result.body.error === 'sold_out') {
        submitButton.textContent = 'Ce pass est complet';
      } else {
        submitButton.textContent = 'Corriger et réessayer ↗';
      }
      submitButton.disabled = result.body.error === 'sold_out';
    }
    await Promise.allSettled([loadEvents(), loadStatus()]);
  } catch {
    bookingMessage.textContent = 'La connexion a été interrompue. Le résultat reste à vérifier. Réessaie avec ce bouton : la même demande sera reprise, sans double achat.';
    submitButton.textContent = 'Vérifier ma demande initiale ↗';
    submitButton.disabled = false;
  } finally {
    state.busy = false;
    if (!state.pending && submitButton.textContent !== 'Ce pass est complet') submitButton.disabled = false;
  }
}

// Une confirmation mémorise seulement la référence sur cet appareil. Sans cette
// liste, le visiteur devrait recopier son identifiant après chaque consultation.
function rememberTicket(booking) {
  if (booking.payment_status !== 'accepted') return;
  const saved = readStorage('resonance.tickets', []);
  const list = Array.isArray(saved) ? saved : [];
  const entry = { id: booking.id, artist: booking.artist, name: booking.name };
  writeStorage('resonance.tickets', [entry, ...list.filter((item) => item.id !== booking.id)].slice(0, 50));
}

// La confirmation et la consultation partagent un billet imprimable avec son
// vrai jeton. Sans cette vue, le contrôle organisateur n'aurait aucune référence utilisable.
function renderTicket(booking) {
  const checked = Boolean(booking.checked_at);
  const root = document.querySelector('#ticket-content');
  root.innerHTML = `<article class="ticket"><div class="ticket-top"><p class="eyebrow">[ GLITCH 2027 ] · PASS DE DÉMONSTRATION</p><h2 id="ticket-heading">${escapeHTML(booking.title)}</h2><p>${escapeHTML(booking.artist)}</p></div><div class="ticket-body"><div class="ticket-info"><div><span>RENDEZ-VOUS</span><strong>${escapeHTML(dateLabel.format(new Date(booking.starts_at)))}</strong></div><div><span>OUVERTURE À</span><strong>${escapeHTML(timeLabel.format(new Date(booking.starts_at)))}</strong></div><div><span>PSEUDONYME</span><strong>${escapeHTML(booking.name)}</strong></div><div><span>ESPACE</span><strong>${escapeHTML(booking.stage)}</strong></div></div><div class="ticket-state ${checked ? 'checked' : ''}">${checked ? '● Billet déjà contrôlé · un seul passage autorisé' : '● Pass confirmé · billet prêt pour un passage'}</div><p class="ticket-reference">Référence complète de la réservation<br><strong>${escapeHTML(booking.id)}</strong></p></div><div class="ticket-tail"><label>JETON À PRÉSENTER À L’ENTRÉE</label><p class="ticket-token">${escapeHTML(booking.ticket_token)}</p><p class="field-help">Conserve la référence complète pour retrouver ce billet. Le jeton est privé : il permet un seul passage. Paiement simulé, aucun débit.</p><div class="ticket-actions"><button type="button" class="button" id="copy-reference">Copier la référence ↗</button><button type="button" class="button acid" id="print-ticket">Imprimer le billet ↗</button></div></div></article>`;
  document.querySelector('#copy-reference').addEventListener('click', () => copyReference(booking.id));
  document.querySelector('#print-ticket').addEventListener('click', () => window.print());
}

// Le bouton de billet copie la référence sans inclure le jeton organisateur.
// Si le presse-papiers est interdit, ce retour invite à une sélection manuelle.
async function copyReference(reference) {
  try {
    await navigator.clipboard.writeText(reference);
    toast('Référence copiée. Conserve-la pour retrouver ton billet.');
  } catch {
    toast('Sélectionne la référence complète sur le billet pour la copier.');
  }
}

// La liste locale et la recherche vérifient le billet dans la vraie base.
// Sans cette relecture, le navigateur pourrait afficher comme neuf un billet déjà contrôlé.
async function showTicket(id) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) {
    throw new Error('Utilise la référence complète figurant sur le billet.');
  }
  const result = await api(`/api/bookings/${encodeURIComponent(id)}`);
  if (result.status !== 200) throw new Error(result.body.message ?? 'La consultation est momentanément indisponible.');
  if (result.body.booking.payment_status !== 'accepted') throw new Error('Ce paiement a été refusé. Aucun billet n’a été émis.');
  rememberTicket(result.body.booking);
  renderTicket(result.body.booking);
  openDialog(document.querySelector('#ticket-dialog'));
}

// Le lien Mes billets présente les références enregistrées sur ce navigateur.
// Sans ce sélecteur, seul le dernier billet affiché resterait facilement accessible.
function openTickets() {
  const saved = readStorage('resonance.tickets', []);
  const list = Array.isArray(saved) ? saved : [];
  const container = document.querySelector('#saved-tickets');
  container.innerHTML = list.length ? list.map((item) => `<button class="saved-ticket" type="button" data-booking-id="${escapeHTML(item.id)}"><span><strong>${escapeHTML(item.artist)}</strong><small>${escapeHTML(item.name)} · ${escapeHTML(item.id.slice(0, 8).toUpperCase())}</small></span><span aria-hidden="true">↗</span></button>`).join('') : '<p class="field-help">Pas encore de billet sur cet appareil. Ton prochain pass t’attend dans la programmation GLITCH.</p>';
  container.querySelectorAll('[data-booking-id]').forEach((button) => button.addEventListener('click', () => showTicket(button.dataset.bookingId).catch((error) => toast(error.message))));
  document.querySelector('#lookup-message').textContent = '';
  openDialog(document.querySelector('#tickets-dialog'));
}

// Le formulaire de référence ouvre un billet conservé ailleurs. Sans cette entrée,
// changer de navigateur ferait perdre l'accès malgré une référence complète sauvegardée.
async function lookupTicket(event) {
  event.preventDefault();
  const message = document.querySelector('#lookup-message');
  message.textContent = 'On cherche ton billet…';
  try {
    await showTicket(document.querySelector('#booking-reference').value.trim().toLowerCase());
    message.textContent = '';
  } catch (error) {
    message.textContent = error.message;
  }
}

// L'organisateur envoie le jeton au contrôle protégé, sans le mémoriser.
// Sans cette requête réelle, l'interface ne pourrait pas empêcher un deuxième passage.
async function submitCheck(event) {
  event.preventDefault();
  const token = document.querySelector('#ticket-token').value.trim().toLowerCase();
  const adminInput = document.querySelector('#admin-token');
  const message = document.querySelector('#admin-message');
  const button = event.currentTarget.querySelector('button[type="submit"]');
  message.className = 'form-message';
  if (!/^[a-f0-9]{64}$/.test(token)) {
    message.textContent = 'Le jeton du billet doit contenir exactement 64 caractères hexadécimaux.';
    return;
  }
  button.disabled = true;
  message.textContent = 'Contrôle en cours…';
  try {
    const result = await api(`/api/tickets/${encodeURIComponent(token)}/check`, {
      method: 'POST', headers: { 'X-Admin-Token': adminInput.value.trim() },
    });
    message.textContent = result.status === 200 ? `Entrée validée pour ${result.body.booking.name}. Bienvenue à GLITCH !` : result.body.message ?? 'Le contrôle a échoué.';
    if (result.status === 200) message.classList.add('success');
  } catch {
    message.textContent = 'Connexion interrompue. Vérifie le résultat avant de laisser entrer. Un nouvel essai signalera un billet déjà contrôlé si le passage a été validé.';
  } finally {
    button.disabled = false;
  }
}

// Le démarrage restaure uniquement une intention bien formée puis branche les
// interactions. Sans ce contrôle, un stockage ancien pourrait casser la reprise.
function initialize() {
  const pending = readStorage('resonance.pending', null);
  if (pending && /^[a-zA-Z0-9._:-]{8,128}$/.test(pending.key)
    && Number.isInteger(pending.payload?.event_id) && typeof pending.payload?.name === 'string'
    && ['accepted', 'declined'].includes(pending.payload?.payment)) state.pending = pending;
  renderPending();
  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  bookingForm.addEventListener('submit', submitBooking);
  document.querySelector('#my-tickets').addEventListener('click', openTickets);
  document.querySelector('#lookup-form').addEventListener('submit', lookupTicket);
  document.querySelector('#resume-booking').addEventListener('click', () => openBooking(state.pending?.payload.event_id));
  document.querySelector('#refresh-events').addEventListener('click', () => { loadEvents(); loadStatus(); });
  document.querySelector('#open-admin').addEventListener('click', () => {
    document.querySelector('#admin-message').textContent = '';
    openDialog(document.querySelector('#admin-dialog'));
  });
  document.querySelector('#admin-dialog').addEventListener('close', () => { document.querySelector('#admin-token').value = ''; });
  document.querySelector('#admin-form').addEventListener('submit', submitCheck);
  loadEvents();
  loadStatus();
}

initialize();
