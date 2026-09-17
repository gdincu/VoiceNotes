// ui.js — pure(ish) DOM rendering helpers. This module knows how to draw
// the recordings list and toasts; it holds no browser-API or storage logic.

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function formatTimestamp(ms) {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today · ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;

  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${date} · ${time}`;
}

/**
 * Builds a single recording list item as a DOM node with all its controls
 * wired to the callbacks provided. Kept as one function so app.js never has
 * to know the markup shape.
 */
export function renderRecordingItem(record, handlers) {
  const li = document.createElement('li');
  li.className = 'rec-card';
  li.dataset.id = record.id;

  const canShareFile = handlers.canShareFile(record);

  li.innerHTML = `
    <div class="rec-card__top">
      <div class="rec-card__meta" data-role="meta">
        ${metaMarkup(record)}
      </div>
      <div class="rec-card__actions">
        <button type="button" class="icon-btn" data-action="rename" aria-label="Rename recording" title="Rename">
          ${icon('edit')}
        </button>
        ${canShareFile ? `
        <button type="button" class="icon-btn" data-action="share" aria-label="Share recording" title="Share">
          ${icon('share')}
        </button>` : ''}
        <button type="button" class="icon-btn" data-action="download" aria-label="Download recording" title="Download">
          ${icon('download')}
        </button>
        <button type="button" class="icon-btn icon-btn--danger" data-action="delete" aria-label="Delete recording" title="Delete">
          ${icon('trash')}
        </button>
      </div>
    </div>
    <div class="rec-card__player">
      <button type="button" class="play-btn" data-action="toggle-play" aria-label="Play recording">
        ${icon('play')}
      </button>
      <div class="rec-card__progress-wrap">
        <input type="range" class="rec-card__progress" min="0" max="1000" value="0"
          aria-label="Playback position" data-role="progress" />
        <div class="rec-card__time">
          <span data-role="current-time">0:00</span>
          <span data-role="total-time">${formatDuration(record.duration)}</span>
        </div>
      </div>
    </div>
  `;

  const playBtn = li.querySelector('[data-action="toggle-play"]');
  const progress = li.querySelector('[data-role="progress"]');
  const currentTimeEl = li.querySelector('[data-role="current-time"]');
  const renameBtn = li.querySelector('[data-action="rename"]');
  const shareBtn = li.querySelector('[data-action="share"]');
  const downloadBtn = li.querySelector('[data-action="download"]');
  const deleteBtn = li.querySelector('[data-action="delete"]');
  const meta = li.querySelector('[data-role="meta"]');

  playBtn.addEventListener('click', () => handlers.onTogglePlay(record, li));
  // While the user is actively dragging the thumb we must not let
  // timeupdate overwrite the slider position, or the thumb snaps back and
  // seeking feels broken. `change` commits the final position (covers
  // keyboard + click-to-jump where `input` may be throttled).
  const endScrub = () => { li._els.scrubbing = false; };
  progress.addEventListener('pointerdown', () => {
    li._els.scrubbing = true;
    // If the pointer is released off-element, the input's own pointerup may
    // not fire — the window fallback guarantees the slider resumes
    // auto-progress instead of freezing.
    window.addEventListener('pointerup', endScrub, { once: true });
    window.addEventListener('pointercancel', endScrub, { once: true });
  });
  progress.addEventListener('pointerup', endScrub);
  progress.addEventListener('pointercancel', endScrub);
  progress.addEventListener('blur', endScrub);
  progress.addEventListener('input', () => handlers.onSeek(record, li, Number(progress.value)));
  progress.addEventListener('change', () => {
    endScrub();
    handlers.onSeek(record, li, Number(progress.value));
  });
  renameBtn.addEventListener('click', () => handlers.onRename(record, li));
  if (shareBtn) shareBtn.addEventListener('click', () => handlers.onShare(record));
  if (downloadBtn) downloadBtn.addEventListener('click', () => handlers.onDownload(record));
  deleteBtn.addEventListener('click', () => handlers.onDeleteRequest(record, li));

  li._els = { playBtn, progress, currentTimeEl, meta, audio: null, objectUrl: null, scrubbing: false };
  return li;
}

/**
 * The title/date block for a recording: a custom title (if the user set
 * one) shown as the primary line with the date/time as a small secondary
 * line, or — the default, unchanged behavior — just the date/time as the
 * primary line when no title has been set.
 */
function metaMarkup(record) {
  const timestamp = formatTimestamp(record.createdAt);
  const hasTitle = !!(record.title && record.title.trim());
  const primary = hasTitle ? escapeHtml(record.title.trim()) : timestamp;
  const secondary = hasTitle ? `<span class="rec-card__date rec-card__date--sub">${timestamp}</span>` : '';
  return `
    <span class="rec-card__date">${primary}</span>
    ${secondary}
    <span class="rec-card__duration">${formatDuration(record.duration)}</span>
  `;
}

/** Re-renders just the title/date block after a rename, without rebuilding the whole card. */
export function updateRecordingCardMeta(li, record) {
  li._els.meta.innerHTML = metaMarkup(record);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function setPlayButtonState(li, isPlaying) {
  const { playBtn } = li._els;
  playBtn.innerHTML = isPlaying ? icon('pause') : icon('play');
  playBtn.setAttribute('aria-label', isPlaying ? 'Pause recording' : 'Play recording');
}

export function updatePlaybackProgress(li, currentTime, duration) {
  const { progress, currentTimeEl } = li._els;
  const pos = duration > 0 ? (currentTime / duration) * Number(progress.max || 1000) : 0;
  // Only suppress programmatic updates while actively scrubbing. Do NOT gate
  // on document.activeElement: the slider keeps focus after a drag, which
  // would otherwise freeze auto-progress for the rest of playback.
  if (!li._els.scrubbing) progress.value = String(Math.round(pos));
  currentTimeEl.textContent = formatDuration(currentTime);
}

export function renderEmptyState(listEl) {
  listEl.innerHTML = `
    <li class="empty-state" role="note">
      <p>No recordings yet.</p>
      <p class="empty-state__hint">Tap the microphone to capture your first voice note.</p>
    </li>
  `;
}

/**
 * Minimal toast/status messaging. Only one toast is shown at a time.
 */
let toastTimer = null;
export function showToast(message, { isError = false } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle('toast--error', !!isError);
  el.classList.add('toast--visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast--visible'), 3800);
}

/**
 * Confirmation dialog for destructive actions. Uses the native <dialog>
 * element (supported by all evergreen browsers).
 * @returns {Promise<boolean>}
 */
export function confirmDialog(message) {
  const dialog = document.getElementById('confirm-dialog');
  const messageEl = dialog.querySelector('[data-role="confirm-message"]');
  const confirmBtn = dialog.querySelector('[data-action="confirm-yes"]');
  const cancelBtn = dialog.querySelector('[data-action="confirm-no"]');
  messageEl.textContent = message;

  return new Promise((resolve) => {
    const cleanup = (result) => {
      confirmBtn.removeEventListener('click', onYes);
      cancelBtn.removeEventListener('click', onNo);
      dialog.removeEventListener('cancel', onCancel);
      dialog.close();
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    const onCancel = () => cleanup(false);

    confirmBtn.addEventListener('click', onYes);
    cancelBtn.addEventListener('click', onNo);
    dialog.addEventListener('cancel', onCancel);

    dialog.showModal();
  });
}

/**
 * Text-entry dialog used both to optionally name a recording right after
 * saving it, and to rename an existing one later. Uses the native
 * <dialog> element (supported by all evergreen browsers).
 *
 * @param {{heading:string, initialValue?:string, placeholder?:string, confirmLabel?:string}} opts
 * @returns {Promise<string|null>} the trimmed name, or null if the user
 * cancelled (meaning: leave things as they were / use the default placeholder).
 */
export function promptForName({ heading, initialValue = '', placeholder = '', confirmLabel = 'Save' } = {}) {
  const dialog = document.getElementById('name-dialog');
  const headingEl = dialog.querySelector('[data-role="name-heading"]');
  const input = dialog.querySelector('[data-role="name-input"]');
  const saveBtn = dialog.querySelector('[data-action="name-save"]');
  const cancelBtn = dialog.querySelector('[data-action="name-cancel"]');

  headingEl.textContent = heading;
  input.value = initialValue;
  input.placeholder = placeholder;
  saveBtn.textContent = confirmLabel;

  return new Promise((resolve) => {
    const cleanup = (result) => {
      saveBtn.removeEventListener('click', onSave);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKeydown);
      dialog.removeEventListener('cancel', onDialogCancel);
      dialog.close();
      resolve(result);
    };
    const onSave = () => cleanup(input.value.trim());
    const onCancel = () => cleanup(null);
    const onDialogCancel = (e) => { e.preventDefault(); cleanup(null); };
    const onKeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onSave(); }
    };

    saveBtn.addEventListener('click', onSave);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKeydown);
    dialog.addEventListener('cancel', onDialogCancel);

    dialog.showModal();
    input.focus();
    input.select();
  });
}

function icon(name) {
  const icons = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12l-1 13H7L6 7zm3-3h6l1 2H8l1-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M6 14v4a2 2 0 002 2h8a2 2 0 002-2v-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M6 19h12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10.5-10.5a1.5 1.5 0 0 0 0-2.12l-1.88-1.88a1.5 1.5 0 0 0-2.12 0L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  };
  return icons[name] || '';
}
