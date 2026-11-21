(() => {
  'use strict';

  const STORAGE_KEY = 'dziennik-temperatur:v1';
  const SYNC_KEY = 'dziennik-temperatur:sync';
  // Dozwolony zakres każdej temperatury (°C).
  const TEMP_MIN = -30;
  const TEMP_MAX = 30;
  // Piec ma własny zakres (°C); poza liczbą może też być „off”.
  const FURNACE_MIN = 25;
  const FURNACE_MAX = 40;
  // Nagłówek identyczny jak w oryginalnej tabeli, żeby eksport dało się wkleić z powrotem.
  // Kolumna „zmiana na” nie jest wpisywana: w eksporcie jest pusta, a przy imporcie pomijana
  // (ma być wyliczana w statystykach).
  const HEADER = [
    'data', 'godz', 'temperatura kuchnia', 'temperatura piec',
    'temperatura piec zmiana na', 'temperatura zewnatrz',
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('form'), formTitle: $('form-title'),
    date: $('f-date'), hour: $('f-hour'), kitchen: $('f-kitchen'),
    outside: $('f-outside'), furnace: $('f-furnace'),
    offBtn: $('off-btn'), error: $('error'),
    submit: $('submit'), cancel: $('cancel'), del: $('delete'),
    rows: $('rows'), tableWrap: $('table-wrap'), empty: $('empty'), tapHint: $('tap-hint'),
    count: $('count'), toast: $('toast'),
    copy: $('copy'), download: $('download'), import: $('import'), clear: $('clear'),
    dialog: $('import-dialog'), importText: $('import-text'),
    syncStatus: $('sync-status'), syncSetup: $('sync-setup'), syncNow: $('sync-now'),
    syncDialog: $('sync-dialog'), syncForm: $('sync-form'), syncUrl: $('sync-url'),
    syncKey: $('sync-key'), syncError: $('sync-error'), syncSave: $('sync-save'),
    syncOff: $('sync-off'),
  };

  // ---------- pamięć (localStorage, z zapasem w RAM) ----------
  // Wpis: { id, date, hour, kitchen, furnace, outside, updated, dirty, deleted }
  //  updated – chwila ostatniej zmiany (ms), służy do rozstrzygania konfliktów przy synchronizacji
  //  dirty   – zmiana czeka na wysłanie do arkusza
  //  deleted – „nagrobek”: usunięty wpis, który trzeba jeszcze zgłosić arkuszowi
  let memoryCopy = [];
  let memorySync = null;
  let entries = load();
  let syncConfig = loadSyncConfig();
  let editingId = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (Array.isArray(data)) return data;
      }
    } catch (e) {
      return memoryCopy;
    }
    return [];
  }

  function save() {
    memoryCopy = entries;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (e) {
      toast('Nie udało się zapisać w przeglądarce');
    }
  }

  function loadSyncConfig() {
    try {
      const raw = localStorage.getItem(SYNC_KEY);
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg && cfg.url && cfg.key) return cfg;
      }
    } catch (e) {
      return memorySync;
    }
    return null;
  }

  function saveSyncConfig(cfg) {
    syncConfig = cfg;
    memorySync = cfg;
    try {
      if (cfg) localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
      else localStorage.removeItem(SYNC_KEY);
    } catch (e) {
      /* konfiguracja zostaje w RAM do zamknięcia karty */
    }
  }

  // Wpisy z wersji sprzed synchronizacji nie mają „updated”: oznaczamy je do wysłania.
  function migrate() {
    const now = Date.now();
    let changed = false;
    for (const e of entries) {
      if (typeof e.updated !== 'number') {
        e.updated = now;
        e.dirty = true;
        changed = true;
      }
    }
    return changed;
  }

  const live = () => entries.filter((e) => !e.deleted);
  const nextUpdated = (prev) => Math.max(Date.now(), (prev || 0) + 1);

  // ---------- daty i liczby ----------
  const pad = (n) => String(n).padStart(2, '0');

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function isoToPl(iso) {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }

  function isoToShort(iso) {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y.slice(2)}`;
  }

  function plToIso(text) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(text).trim());
    if (!m) return null;
    const day = +m[1], month = +m[2], year = +m[3];
    const dt = new Date(year, month - 1, day);
    if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
    return `${year}-${pad(month)}-${pad(day)}`;
  }

  // Temperatura: opcjonalny znak, liczba całkowita albo z JEDNYM miejscem po przecinku lub kropce.
  // Zwraca { ok: true, value: liczba|null } albo { ok: false, reason: 'format' | 'decimals' }.
  function parseNum(text) {
    const s = String(text ?? '').trim().replace(/\s/g, '').replace('−', '-').replace(',', '.').replace(/^\+/, '');
    if (s === '') return { ok: true, value: null };
    if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, reason: 'format' };
    if (/\.\d{2,}$/.test(s)) return { ok: false, reason: 'decimals' };
    return { ok: true, value: Number(s) };
  }

  // Piec: liczba, „off” albo puste.
  function parseFurnace(text) {
    const s = String(text ?? '').trim();
    if (/^(off|wył\.?|wyl\.?|wyłączony)$/i.test(s)) return { ok: true, value: 'off' };
    return parseNum(s);
  }

  const fmtNum = (n) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
  const fmtFurnace = (v) => (v === 'off' ? 'off' : fmtNum(v));

  function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (n === 1) return one;
    if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return few;
    return many;
  }

  function fmtWhen(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === new Date().toDateString()
      ? `dziś ${time}`
      : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${time}`;
  }

  // ---------- sortowanie ----------
  const hourKey = (e) => (e.hour === null || e.hour === undefined ? -1 : e.hour);
  const compareAsc = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : hourKey(a) - hourKey(b));

  // ---------- lista ----------
  function td(text, className) {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function valueCell(text) {
    return text === '' ? td('—', 'none') : td(text);
  }

  function rowEl(e) {
    const tr = document.createElement('tr');
    tr.dataset.id = e.id;
    tr.tabIndex = 0;
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-label', `Edytuj wpis z ${isoToPl(e.date)}`);
    if (e.id === editingId) tr.classList.add('editing');

    tr.append(
      td(isoToShort(e.date), 'left'),
      e.hour === null || e.hour === undefined ? td('—', 'none') : td(String(e.hour)),
      valueCell(fmtNum(e.kitchen)),
      e.furnace === 'off' ? td('off', 'off') : valueCell(fmtNum(e.furnace)),
      valueCell(fmtNum(e.outside)),
    );
    return tr;
  }

  function render() {
    const list = live().sort(compareAsc).reverse();
    els.rows.replaceChildren(...list.map(rowEl));
    const hasAny = list.length > 0;
    els.tableWrap.hidden = !hasAny;
    els.empty.hidden = hasAny;
    els.tapHint.hidden = !hasAny;
    renderHeader();
  }

  function renderHeader() {
    const n = live().length;
    let text = n ? `${n} ${plural(n, 'wpis', 'wpisy', 'wpisów')}` : 'Brak wpisów';
    if (syncConfig) text += ` · ${syncShort()}`;
    els.count.textContent = text;
  }

  // ---------- formularz ----------
  // Data i godzina podpowiadają się z chwili otwarcia formularza (godzina pełna, bez minut).
  let defaultsTouched = false;

  const hourToTime = (h) => (h === null || h === undefined ? '' : `${pad(h)}:00`);

  function applyDefaults() {
    els.date.value = todayIso();
    els.hour.value = hourToTime(new Date().getHours());
  }

  // Gdy aplikacja leżała w tle, podpowiedź mogła się zestarzeć. Odświeżamy ją tylko,
  // jeśli nikt nie zmieniał daty ani godziny i nie edytujemy wpisu.
  function refreshDefaults() {
    if (!editingId && !defaultsTouched) applyDefaults();
  }

  function resetForm() {
    editingId = null;
    els.form.reset();
    applyDefaults();
    defaultsTouched = false;
    els.formTitle.textContent = 'Nowy wpis';
    els.submit.textContent = 'Dodaj wpis';
    els.cancel.hidden = true;
    els.del.hidden = true;
    hideError();
  }

  function startEdit(id) {
    const e = entries.find((x) => x.id === id && !x.deleted);
    if (!e) return;
    editingId = id;
    els.date.value = e.date;
    els.hour.value = hourToTime(e.hour);
    els.kitchen.value = fmtNum(e.kitchen);
    els.outside.value = fmtNum(e.outside);
    els.furnace.value = fmtFurnace(e.furnace);
    els.formTitle.textContent = 'Edytuj wpis';
    els.submit.textContent = 'Zapisz zmiany';
    els.cancel.hidden = false;
    els.del.hidden = false;
    hideError();
    render();
    els.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = false;
  }

  function hideError() {
    els.error.hidden = true;
    els.error.textContent = '';
  }

  // Wymagane pole z temperaturą: liczba od TEMP_MIN do TEMP_MAX, najwyżej jedno miejsce po
  // przecinku. Dla pieca (allowOff) może też być „off”. Zwraca { value } albo { error, field }.
  function tempFrom(input, label, example, { allowOff = false, min = TEMP_MIN, max = TEMP_MAX } = {}) {
    const text = input.value.trim();
    if (text === '') {
      return { error: `Uzupełnij pole „${label}”${allowOff ? ' (liczba albo off)' : ''}.`, field: input };
    }
    const parsed = allowOff ? parseFurnace(text) : parseNum(text);
    if (!parsed.ok) {
      const error = parsed.reason === 'decimals'
        ? `${label}: tylko jedno miejsce po przecinku, np. ${example}.`
        : `${label}: wpisz liczbę${allowOff ? ' albo „off”' : ''}, np. ${example}.`;
      return { error, field: input };
    }
    if (parsed.value !== 'off' && (parsed.value < min || parsed.value > max)) {
      return {
        error: `${label}: temperatura musi być od ${min} do ${max} °C${allowOff ? ' (albo off)' : ''}.`,
        field: input,
      };
    }
    return { value: parsed.value };
  }

  // Wszystkie pola są wymagane. Zwraca { value } albo { error, field }.
  function readForm() {
    if (!els.date.value) return { error: 'Uzupełnij datę.', field: els.date };

    const timeMatch = /^(\d{1,2}):(\d{2})/.exec(els.hour.value.trim());
    if (!timeMatch) return { error: 'Uzupełnij godzinę.', field: els.hour };
    const hour = Number(timeMatch[1]);
    if (hour > 23) return { error: 'Godzina musi być od 0 do 23.', field: els.hour };

    const kitchen = tempFrom(els.kitchen, 'Kuchnia', '20,5');
    if (kitchen.error) return kitchen;
    const outside = tempFrom(els.outside, 'Zewnątrz', '-3,5');
    if (outside.error) return outside;
    const furnace = tempFrom(els.furnace, 'Piec', '30', { allowOff: true, min: FURNACE_MIN, max: FURNACE_MAX });
    if (furnace.error) return furnace;

    return {
      value: {
        date: els.date.value,
        hour,
        kitchen: kitchen.value,
        furnace: furnace.value,
        outside: outside.value,
      },
    };
  }

  els.form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const result = readForm();
    if (result.error) {
      showError(result.error);
      result.field.focus();
      return;
    }
    const i = editingId ? entries.findIndex((x) => x.id === editingId && !x.deleted) : -1;
    if (i >= 0) {
      entries[i] = { id: editingId, ...result.value, updated: nextUpdated(entries[i].updated), dirty: true };
      toast('Zapisano zmiany');
    } else {
      entries.push({ id: newId(), ...result.value, updated: Date.now(), dirty: true });
      toast('Dodano wpis');
    }
    save();
    resetForm();
    render();
    scheduleSync();
  });

  els.offBtn.addEventListener('click', () => {
    els.furnace.value = 'off';
  });

  // Klawiatura liczbowa na telefonie często nie ma minusa, więc przy polach temperatury
  // jest przycisk ± (zmiana znaku).
  document.querySelectorAll('.sign').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      const v = input.value.trim();
      if (/^off$/i.test(v)) return;
      input.value = v.startsWith('-') ? v.slice(1) : `-${v}`;
      input.focus();
    });
  });

  // Godzina zawsze „pełna”: minuty zerujemy, bo zapisujemy tylko godzinę.
  els.hour.addEventListener('change', () => {
    if (els.hour.value) els.hour.value = `${els.hour.value.slice(0, 2)}:00`;
  });
  els.date.addEventListener('input', () => { defaultsTouched = true; });
  els.hour.addEventListener('input', () => { defaultsTouched = true; });

  els.cancel.addEventListener('click', () => {
    resetForm();
    render();
  });

  // Usuwanie: przy włączonej synchronizacji zostaje „nagrobek”, żeby arkusz i inne urządzenia
  // też usunęły wpis. Bez synchronizacji wpis znika od razu.
  function removeEntry(id) {
    const i = entries.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (syncConfig) {
      entries[i] = { ...entries[i], deleted: true, updated: nextUpdated(entries[i].updated), dirty: true };
    } else {
      entries.splice(i, 1);
    }
  }

  els.del.addEventListener('click', () => {
    if (!editingId || !confirm('Usunąć ten wpis?')) return;
    removeEntry(editingId);
    save();
    resetForm();
    render();
    toast('Usunięto wpis');
    scheduleSync();
  });

  els.rows.addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr');
    if (tr) startEdit(tr.dataset.id);
  });

  els.rows.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const tr = ev.target.closest('tr');
    if (!tr) return;
    ev.preventDefault();
    startEdit(tr.dataset.id);
  });

  // ---------- eksport ----------
  function exportRows() {
    return live().sort(compareAsc).map((e) => [
      isoToPl(e.date),
      e.hour === null || e.hour === undefined ? '' : String(e.hour),
      fmtNum(e.kitchen),
      fmtFurnace(e.furnace),
      '', // „zmiana na”: wyliczana w statystykach, nie wpisywana
      fmtNum(e.outside),
    ]);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // zapasowo, gdy Clipboard API jest niedostępne
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* nic */ }
    ta.remove();
    return ok;
  }

  els.copy.addEventListener('click', async () => {
    if (!live().length) return toast('Brak danych do skopiowania');
    const text = [HEADER, ...exportRows()].map((r) => r.join('\t')).join('\n');
    toast((await copyText(text)) ? 'Skopiowano tabelę' : 'Nie udało się skopiować');
  });

  els.download.addEventListener('click', () => {
    if (!live().length) return toast('Brak danych do pobrania');
    // Średnik + BOM, żeby polski Excel poprawnie rozpoznał kolumny i znaki.
    const csv = '﻿' + [HEADER, ...exportRows()].map((r) => r.join(';')).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `temperatury-${todayIso()}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ---------- import ----------
  // Układ wiersza jak w oryginalnej tabeli: data, godz, kuchnia, piec, piec zmiana na, zewnątrz.
  // Kolumnę „zmiana na” (piąta) pomijamy.
  function parseImport(text) {
    const parsed = [];
    let skipped = 0;

    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cells = line.split(line.includes('\t') ? '\t' : ';').map((c) => c.trim());
      if (/^data$/i.test(cells[0])) continue; // nagłówek

      const date = plToIso(cells[0]);
      if (!date) { skipped++; continue; }

      const kitchen = parseNum(cells[2]);
      const furnace = parseFurnace(cells[3]);
      const outside = parseNum(cells[5]);
      if (![kitchen, furnace, outside].every((x) => x.ok)) { skipped++; continue; }
      const outOfRange = [
        [kitchen, TEMP_MIN, TEMP_MAX],
        [outside, TEMP_MIN, TEMP_MAX],
        [furnace, FURNACE_MIN, FURNACE_MAX],
      ].some(([x, min, max]) => typeof x.value === 'number' && (x.value < min || x.value > max));
      if (outOfRange) { skipped++; continue; } // temperatura poza dozwolonym zakresem
      if ([kitchen, furnace, outside].every((x) => x.value === null)) continue; // pusty dzień

      // Wszystkie pola są wymagane: godzina, kuchnia, piec i zewnątrz.
      const hourText = cells[1] || '';
      const hour = hourText === '' ? NaN : Number(hourText);
      const complete = Number.isInteger(hour) && hour >= 0 && hour <= 23 &&
        kitchen.value !== null && furnace.value !== null && outside.value !== null;
      if (!complete) { skipped++; continue; }

      parsed.push({
        date, hour,
        kitchen: kitchen.value, furnace: furnace.value, outside: outside.value,
      });
    }
    return { parsed, skipped };
  }

  const sameEntry = (a, b) =>
    a.date === b.date && a.hour === b.hour && a.kitchen === b.kitchen &&
    a.furnace === b.furnace && a.outside === b.outside;

  els.import.addEventListener('click', () => {
    els.importText.value = '';
    els.dialog.showModal();
    els.importText.focus();
  });

  // Import odpala się na „submit” formularza w oknie (przycisk „Importuj”), a nie na „close”,
  // bo „submit” przychodzi od razu i nie zależy od kolejki zdarzeń okna dialogowego.
  els.dialog.querySelector('form').addEventListener('submit', (ev) => {
    if (!ev.submitter || ev.submitter.value !== 'ok') return;
    const result = parseImport(els.importText.value);
    const parsed = result.parsed;
    let skipped = result.skipped;
    let added = 0;
    for (const item of parsed) {
      if (live().some((e) => sameEntry(e, item))) { skipped++; continue; }
      entries.push({ id: newId(), ...item, updated: Date.now(), dirty: true });
      added++;
    }
    if (added) { save(); render(); scheduleSync(); }
    const parts = [`Zaimportowano: ${added}`];
    if (skipped) parts.push(`pominięto: ${skipped}`);
    toast(parts.join(', '));
  });

  els.clear.addEventListener('click', () => {
    if (!live().length) return toast('Nie ma czego czyścić');
    const message = syncConfig
      ? 'Usunąć WSZYSTKIE wpisy? Znikną też z arkusza i z innych urządzeń. (Wcześniej możesz je skopiować przyciskiem „Kopiuj tabelę”.)'
      : 'Usunąć WSZYSTKIE wpisy? Tego nie da się cofnąć. (Wcześniej możesz je skopiować przyciskiem „Kopiuj tabelę”.)';
    if (!confirm(message)) return;
    live().forEach((e) => removeEntry(e.id));
    save();
    resetForm();
    render();
    toast('Wyczyszczono');
    scheduleSync();
  });

  // ---------- synchronizacja z arkuszem Google ----------
  // Aplikacja najpierw zapisuje u siebie, a potem w tle wysyła zmiany do skryptu w arkuszu
  // i pobiera zmiany z innych urządzeń. Przy konflikcie wygrywa nowsza zmiana.
  const syncState = { running: false, queued: false, error: '', offline: navigator.onLine === false, timer: null };

  const pending = () => entries.filter((e) => e.dirty).length;

  function syncShort() {
    const n = pending();
    if (syncState.running) return 'synchronizuję…';
    if (syncState.error) return n ? `błąd synchronizacji, do wysłania: ${n}` : 'błąd synchronizacji';
    if (syncState.offline) return n ? `offline, do wysłania: ${n}` : 'offline';
    if (n) return `do wysłania: ${n}`;
    return syncConfig.lastSync ? `zsynchronizowano ${fmtWhen(syncConfig.lastSync)}` : 'jeszcze nie zsynchronizowano';
  }

  function renderSync() {
    const n = pending();
    const waiting = n ? ` Do wysłania: ${n}.` : '';
    let line;
    if (!syncConfig) {
      line = 'Wyłączona. Dane są tylko w tej przeglądarce, na tym urządzeniu.';
    } else if (syncState.running) {
      line = 'Synchronizuję…';
    } else if (syncState.error) {
      line = `Ostatnia próba nie powiodła się: ${syncState.error}${waiting}`;
    } else if (syncState.offline) {
      line = `Brak internetu. Wpisy wyślą się, gdy wróci połączenie.${waiting}`;
    } else {
      line = `Włączona. Ostatnia synchronizacja: ${fmtWhen(syncConfig.lastSync) || 'jeszcze nie było'}.${waiting}`;
    }
    els.syncStatus.textContent = line;
    els.syncSetup.textContent = syncConfig ? 'Ustawienia' : 'Skonfiguruj';
    els.syncNow.hidden = !syncConfig;
    renderHeader();
  }

  function scheduleSync(delay = 400) {
    if (!syncConfig) return;
    clearTimeout(syncState.timer);
    syncState.timer = setTimeout(() => syncNow(), delay);
  }

  function makeError(message) {
    return new Error(message);
  }

  async function callServer(cfg, changes) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res;
    try {
      res = await fetch(cfg.url, {
        method: 'POST',
        // text/plain, żeby przeglądarka nie wysyłała dodatkowego zapytania wstępnego (CORS)
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: cfg.key, since: cfg.cursor || 0, changes }),
        signal: ctrl.signal,
        credentials: 'omit',
      });
    } catch (e) {
      throw makeError(ctrl.signal.aborted
        ? 'Serwer nie odpowiedział w 30 sekund.'
        : 'Nie udało się połączyć z serwerem. Sprawdź internet, adres i czy dostęp wdrożenia to „Wszyscy”.');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw makeError(`Serwer zwrócił błąd (HTTP ${res.status}). Spróbuj ponownie za chwilę.`);
    }
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw makeError('Adres nie odpowiada jak skrypt synchronizacji. Sprawdź adres i czy dostęp wdrożenia to „Wszyscy”.');
    }
    if (!data || !data.ok) {
      throw makeError(data && data.error === 'bad_key'
        ? 'Zły klucz.'
        : `Skrypt zgłosił błąd (${(data && data.error) || 'nieznany'}).`);
    }
    if (typeof data.now !== 'number' || !Array.isArray(data.entries)) {
      throw makeError('Skrypt zwrócił nieoczekiwaną odpowiedź. Wdróż go ponownie z aktualnego pliku Code.gs.');
    }
    return data;
  }

  function validEntry(s) {
    return typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) &&
      Number.isInteger(s.hour) && s.hour >= 0 && s.hour <= 23 &&
      Number.isFinite(s.kitchen) && Number.isFinite(s.outside) &&
      (s.furnace === 'off' || Number.isFinite(s.furnace)) &&
      Number.isFinite(s.updated);
  }

  const fromServer = (s) => ({
    id: s.id, date: s.date, hour: s.hour, kitchen: s.kitchen,
    furnace: s.furnace, outside: s.outside, updated: s.updated, dirty: false,
  });

  const toWire = (e) => ({
    id: e.id, date: e.date, hour: e.hour, kitchen: e.kitchen, furnace: e.furnace,
    outside: e.outside, updated: e.updated, deleted: !!e.deleted,
  });

  // Wchłania odpowiedź skryptu. sent: id → „updated” wysłanej wersji.
  function applyServer(data, sent) {
    for (const s of data.entries) {
      if (!s || typeof s.id !== 'string') continue;
      const i = entries.findIndex((e) => e.id === s.id);
      if (i < 0) {
        if (!s.deleted && validEntry(s)) entries.push(fromServer(s));
        continue;
      }
      const local = entries[i];
      if (s.updated > local.updated) {
        if (s.deleted) entries.splice(i, 1);
        else if (validEntry(s)) entries[i] = fromServer(s);
      } else if (s.updated < local.updated) {
        local.dirty = true; // lokalna wersja jest nowsza: wyślij przy następnej synchronizacji
      }
    }
    // Skrypt potwierdził przetworzenie wysłanych zmian. Nie zdejmujemy flagi z wpisu,
    // który w międzyczasie ktoś zmienił na urządzeniu.
    const acked = new Set(data.ack || []);
    for (const [id, updated] of sent) {
      const local = entries.find((e) => e.id === id);
      if (local && acked.has(id) && local.updated === updated) local.dirty = false;
    }
    entries = entries.filter((e) => !(e.deleted && !e.dirty));
  }

  // Zwraca true, gdy synchronizacja się udała.
  async function syncNow({ manual = false } = {}) {
    if (!syncConfig) return false;
    if (syncState.running) {
      syncState.queued = true;
      return false;
    }
    if (navigator.onLine === false) {
      syncState.offline = true;
      renderSync();
      if (manual) toast('Brak internetu');
      return false;
    }
    syncState.running = true;
    syncState.offline = false;
    renderSync();
    let ok = false;
    try {
      const dirty = entries.filter((e) => e.dirty);
      const sent = new Map(dirty.map((e) => [e.id, e.updated]));
      const data = await callServer(syncConfig, dirty.map(toWire));
      applyServer(data, sent);
      saveSyncConfig({ ...syncConfig, cursor: data.now, lastSync: Date.now() });
      save();
      render();
      syncState.error = '';
      ok = true;
    } catch (e) {
      syncState.error = e.message || 'Błąd synchronizacji.';
    } finally {
      syncState.running = false;
      renderSync();
      if (syncState.queued) {
        syncState.queued = false;
        scheduleSync(0);
      }
    }
    return ok;
  }

  function isAllowedUrl(text) {
    try {
      const u = new URL(text);
      if (u.protocol === 'https:' && u.hostname === 'script.google.com') return true;
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1'; // do testów lokalnych
    } catch (e) {
      return false;
    }
  }

  function showSyncError(message) {
    els.syncError.textContent = message;
    els.syncError.hidden = false;
  }

  els.syncSetup.addEventListener('click', () => {
    els.syncUrl.value = syncConfig ? syncConfig.url : '';
    els.syncKey.value = syncConfig ? syncConfig.key : '';
    els.syncError.hidden = true;
    els.syncOff.hidden = !syncConfig;
    els.syncDialog.showModal();
    if (!syncConfig) els.syncUrl.focus();
  });

  // „Anuluj” zamyka okno zwykłym sposobem; „Zapisz i połącz” najpierw sprawdza połączenie.
  els.syncForm.addEventListener('submit', async (ev) => {
    if (!ev.submitter || ev.submitter.value !== 'ok') return;
    ev.preventDefault();
    const url = els.syncUrl.value.trim();
    const key = els.syncKey.value.trim();
    if (!isAllowedUrl(url)) {
      showSyncError('Adres powinien zaczynać się od https://script.google.com/ i kończyć na /exec.');
      return;
    }
    if (!key) {
      showSyncError('Wpisz klucz.');
      return;
    }
    els.syncError.hidden = true;
    els.syncSave.disabled = true;
    els.syncSave.textContent = 'Łączenie…';
    const previous = syncConfig;
    saveSyncConfig({ url, key, cursor: 0, lastSync: 0 });
    syncState.error = '';
    const ok = await syncNow({ manual: true });
    els.syncSave.disabled = false;
    els.syncSave.textContent = 'Zapisz i połącz';
    if (ok) {
      els.syncDialog.close();
      toast('Połączono z arkuszem');
    } else {
      const reason = syncState.error || 'Trwa inna synchronizacja, spróbuj za chwilę.';
      saveSyncConfig(previous);
      syncState.error = '';
      renderSync();
      showSyncError(reason);
    }
  });

  els.syncOff.addEventListener('click', () => {
    if (!confirm('Wyłączyć synchronizację? Wpisy zostaną na tym urządzeniu i w arkuszu.')) return;
    saveSyncConfig(null);
    entries = entries.filter((e) => !e.deleted);
    syncState.error = '';
    save();
    render();
    renderSync();
    els.syncDialog.close();
    toast('Synchronizacja wyłączona');
  });

  els.syncNow.addEventListener('click', async () => {
    const ok = await syncNow({ manual: true });
    toast(ok ? 'Zsynchronizowano' : 'Nie udało się zsynchronizować');
  });

  window.addEventListener('online', () => {
    syncState.offline = false;
    renderSync();
    scheduleSync(0);
  });

  window.addEventListener('offline', () => {
    syncState.offline = true;
    renderSync();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    refreshDefaults();
    if (syncConfig && Date.now() - (syncConfig.lastSync || 0) > 30000) scheduleSync(0);
  });

  window.addEventListener('pageshow', refreshDefaults);

  // ---------- komunikat ----------
  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2500);
  }

  // ---------- start ----------
  if (migrate()) save();
  resetForm();
  render();
  renderSync();
  scheduleSync(0);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* działa też bez offline */ });
    });
  }
})();
