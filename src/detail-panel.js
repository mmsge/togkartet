import { CONFIG } from './config.js';

const detailPanel = document.getElementById('detail-panel');
const detailContent = document.getElementById('detail-content');
const detailClose = document.getElementById('detail-close');

detailClose.addEventListener('click', closePanel);

export function openPanel() { detailPanel.classList.add('open'); }
export function closePanel() { detailPanel.classList.remove('open'); }
export function showSpinner() { detailContent.innerHTML = '<div class="spinner"></div>'; }
export function setDetailContent(html) { detailContent.innerHTML = html; }

export function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmt(isoStr) {
  if (!isoStr) return '--:--';
  return new Date(isoStr).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
}

export function delayMinutes(aimed, expected) {
  if (!aimed || !expected) return 0;
  return Math.round((new Date(expected) - new Date(aimed)) / 60000);
}

export function renderJourney(journey, vehicleData) {
  const line = journey.line || {};
  const operator = line.operator?.name || '—';
  const publicCode = line.publicCode || '';
  const lineName = line.name || '';
  const submode = line.transportSubmode || line.transportMode || '';
  const calls = journey.estimatedCalls || [];

  const color = CONFIG.operatorColors[vehicleData.operatorCode] || CONFIG.operatorColors.DEFAULT;

  const now = Date.now();
  let nextIdx = -1;
  for (let i = 0; i < calls.length; i++) {
    const dept = calls[i].expectedDepartureTime || calls[i].aimedDepartureTime;
    if (dept && new Date(dept).getTime() > now) { nextIdx = i; break; }
  }

  const direction = calls.length > 0
    ? (calls[calls.length - 1].quay?.stopPlace?.name || calls[calls.length - 1].quay?.name || '—')
    : '—';

  const stopItems = calls.map((call, i) => {
    const stopName = call.quay?.stopPlace?.name || call.quay?.name || '—';
    const aimed = call.aimedDepartureTime || call.aimedArrivalTime;
    const expected = call.expectedDepartureTime || call.expectedArrivalTime;
    const actual = call.actualArrivalTime;
    const timeStr = fmt(actual || expected || aimed);
    const delay = delayMinutes(aimed, expected);
    const isNext = i === nextIdx;
    let classes = 'stop-item';
    if (isNext) classes += ' next-stop';
    let delayHtml = '';
    if (delay > 1) delayHtml = `<span class="stop-delay">+${delay} min</span>`;
    let nameHtml = `<span class="stop-name">${escHtml(stopName)}</span>`;
    if (call.cancellation) nameHtml = `<span class="stop-name stop-cancelled">${escHtml(stopName)} (innstilt)</span>`;
    return `<li class="${classes}">
      <span class="stop-time">${timeStr}</span>
      ${nameHtml}
      ${delayHtml}
    </li>`;
  });

  const passedItems = nextIdx > 0 ? stopItems.slice(0, nextIdx) : (nextIdx === -1 ? stopItems : []);
  const upcomingItems = nextIdx >= 0 ? stopItems.slice(nextIdx) : [];

  let html = `
    <div class="detail-header">
      <span class="detail-line-badge" style="background:${color}">${escHtml(publicCode)}</span>
      <span class="detail-line-name">${escHtml(lineName)}</span>
    </div>
    <div class="detail-meta">Operatør: ${escHtml(operator)}</div>
    <div class="detail-meta">Modus: ${escHtml(submode)}</div>
    <div class="detail-meta">Retning: ${escHtml(direction)}</div>
  `;

  if (upcomingItems.length > 0) {
    html += `<div class="detail-section-title">Neste stopp</div><ul class="stop-list">${upcomingItems.join('')}</ul>`;
  }
  if (passedItems.length > 0) {
    html += `<div class="detail-section-title">Passerte stopp</div><ul class="stop-list">${passedItems.join('')}</ul>`;
  }
  if (calls.length === 0) {
    html += '<div class="detail-meta">Ingen stoppinformasjon tilgjengelig.</div>';
  }

  detailContent.innerHTML = html;
}
