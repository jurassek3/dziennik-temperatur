# Dziennik temperatur (PWA)

Prosta aplikacja do zapisywania pomiarów: data, godzina, temperatura w kuchni, temperatura pieca
(liczba albo `off`) i temperatura na zewnątrz. Wszystkie pola są wymagane.

„Zmiana pieca na” nie jest wpisywana. Ma być wyliczana w statystykach (jeszcze ich nie ma).

Zwykłe pliki statyczne, bez budowania i bez backendu. Dane zapisują się w przeglądarce
(`localStorage`), osobno na każdym urządzeniu.

## Pliki

| Plik | Do czego |
|---|---|
| `index.html`, `style.css`, `app.js` | aplikacja |
| `manifest.webmanifest` | dane potrzebne do zainstalowania (nazwa, kolory, ikony) |
| `sw.js` | cache plików, dzięki któremu działa offline |
| `icons/` | ikony 192, 512 i 180 px (iOS) |

## Wdrożenie za darmo (GitHub Pages)

1. Utwórz repo na GitHubie i wrzuć do niego zawartość tego folderu (pliki w katalogu głównym repo).
2. *Settings → Pages → Build and deployment*: źródło `Deploy from a branch`, gałąź `main`, folder `/ (root)`.
3. Po ok. minucie aplikacja jest pod `https://<nick>.github.io/<repo>/`.
4. Na telefonie: Chrome → menu → „Zainstaluj aplikację”; Safari (iPhone) → Udostępnij → „Dodaj do ekranu początkowego”.

## Lokalny podgląd

Service worker wymaga `localhost` albo HTTPS, więc nie otwieraj `index.html` dwuklikiem. Z folderu:

```powershell
npx serve .
```

## Po zmianie plików

W `sw.js` zwiększ numer w `CACHE` (np. `dziennik-temperatur-v2`), inaczej telefon może jeszcze
chwilę pokazywać starą wersję z cache.

## Kopia danych

„Kopiuj tabelę” daje tekst do wklejenia w Excela albo Arkusze Google (ten sam układ kolumn co
oryginalna tabela, z pustą kolumną „zmiana na”). „Importuj” przyjmuje taki sam tekst z powrotem
i pomija kolumnę „zmiana na”. Wyczyszczenie danych
przeglądarki kasuje też wpisy, więc od czasu do czasu warto skopiować tabelę.
