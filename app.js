(() => {
  'use strict';

  const STORAGE_KEY = 'dziennik-temperatur:v1';
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
  };

  // ---------- pamięć (localStorage, z zapasem w RAM) ----------
  let memoryCopy = [];
  let entries = load();
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

  // Zwraca { ok: true, value: liczba|null } albo { ok: false }.
  function parseNum(text) {
    const s = String(text ?? '').trim().replace(/\s/g, '').replace('−', '-').replace(',', '.');
    if (s === '') return { ok: true, value: null };
    if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false };
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
    const list = [...entries].sort(compareAsc).reverse();
    els.rows.replaceChildren(...list.map(rowEl));
    const hasAny = list.length > 0;
    els.tableWrap.hidden = !hasAny;
    els.empty.hidden = hasAny;
    els.tapHint.hidden = !hasAny;
    els.count.textContent = hasAny
      ? `${list.length} ${plural(list.length, 'wpis', 'wpisy', 'wpisów')}`
      : 'Brak wpisów';
  }

  // ---------- formularz ----------
  function resetForm() {
    editingId = null;
    els.form.reset();
    els.date.value = todayIso();
    els.hour.value = String(new Date().getHours());
    els.formTitle.textContent = 'Nowy wpis';
    els.submit.textContent = 'Dodaj wpis';
    els.cancel.hidden = true;
    els.del.hidden = true;
    hideError();
  }

  function startEdit(id) {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    editingId = id;
    els.date.value = e.date;
    els.hour.value = e.hour === null || e.hour === undefined ? '' : String(e.hour);
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

  // Pole liczbowe, które musi być wypełnione. Zwraca { value } albo { error, field }.
  function requiredNumber(input, label, example) {
    const text = input.value.trim();
    if (text === '') return { error: `Uzupełnij pole „${label}”.`, field: input };
    const n = parseNum(text);
    if (!n.ok) return { error: `${label}: wpisz liczbę, np. ${example}.`, field: input };
    return { value: n.value };
  }

  // Wszystkie pola są wymagane. Zwraca { value } albo { error, field }.
  function readForm() {
    if (!els.date.value) return { error: 'Uzupełnij datę.', field: els.date };

    const hourText = els.hour.value.trim();
    if (hourText === '') return { error: 'Uzupełnij godzinę.', field: els.hour };
    const hour = Number(hourText);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return { error: 'Godzina musi być liczbą od 0 do 23.', field: els.hour };
    }

    const kitchen = requiredNumber(els.kitchen, 'Kuchnia', '20,5');
    if (kitchen.error) return kitchen;
    const outside = requiredNumber(els.outside, 'Zewnątrz', '7');
    if (outside.error) return outside;

    if (els.furnace.value.trim() === '') {
      return { error: 'Uzupełnij pole „Piec” (liczba albo off).', field: els.furnace };
    }
    const furnace = parseFurnace(els.furnace.value);
    if (!furnace.ok) return { error: 'Piec: wpisz liczbę albo „off”.', field: els.furnace };

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
    if (editingId) {
      const i = entries.findIndex((x) => x.id === editingId);
      if (i >= 0) entries[i] = { id: editingId, ...result.value };
      toast('Zapisano zmiany');
    } else {
      entries.push({ id: newId(), ...result.value });
      toast('Dodano wpis');
    }
    save();
    resetForm();
    render();
  });

  els.offBtn.addEventListener('click', () => {
    els.furnace.value = 'off';
  });

  els.cancel.addEventListener('click', () => {
    resetForm();
    render();
  });

  els.del.addEventListener('click', () => {
    if (!editingId || !confirm('Usunąć ten wpis?')) return;
    entries = entries.filter((x) => x.id !== editingId);
    save();
    resetForm();
    render();
    toast('Usunięto wpis');
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
    return [...entries].sort(compareAsc).map((e) => [
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
    if (!entries.length) return toast('Brak danych do skopiowania');
    const text = [HEADER, ...exportRows()].map((r) => r.join('\t')).join('\n');
    toast((await copyText(text)) ? 'Skopiowano tabelę' : 'Nie udało się skopiować');
  });

  els.download.addEventListener('click', () => {
    if (!entries.length) return toast('Brak danych do pobrania');
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
      if (entries.some((e) => sameEntry(e, item))) { skipped++; continue; }
      entries.push({ id: newId(), ...item });
      added++;
    }
    if (added) { save(); render(); }
    const parts = [`Zaimportowano: ${added}`];
    if (skipped) parts.push(`pominięto: ${skipped}`);
    toast(parts.join(', '));
  });

  els.clear.addEventListener('click', () => {
    if (!entries.length) return toast('Nie ma czego czyścić');
    if (!confirm('Usunąć WSZYSTKIE wpisy? Tego nie da się cofnąć. (Wcześniej możesz je skopiować przyciskiem „Kopiuj tabelę”.)')) return;
    entries = [];
    save();
    resetForm();
    render();
    toast('Wyczyszczono');
  });

  // ---------- komunikat ----------
  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2500);
  }

  // ---------- start ----------
  resetForm();
  render();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* działa też bez offline */ });
    });
  }
})();
