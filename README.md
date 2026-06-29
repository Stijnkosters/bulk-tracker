# Lean Bulk Console

Persoonlijke macro- en gewichtstracker. Mobile-first, installeerbaar op je beginscherm (PWA), met AI-weekfeedback via de Claude API. Draait op Railway.

## Wat het doet

- **Dagelijks loggen** vanaf je telefoon: gewicht, calorieën, eiwit/vet/koolhydraten, buikomtrek, training, notitie.
- **Hero-kaart** toont je weektempo (kg/week via trendlijn) met verdict: op koers / te snel / te traag.
- **Weekgemiddelden** vs je targets, met kleurcodering (groen op target, geel onder, rood over).
- **Gewichtsgrafiek** met je dagelijkse metingen en de 7-daagse trendlijn erover.
- **Export naar Excel (CSV)** met één knop: alle gelogde dagen in één bestand.
- **Weekfeedback** met één knop: de app stuurt je data naar Claude en krijgt concrete acties terug. Geen API-key? Dan kopieer je je weekdata en plak je 'm in een Claude-chat.
- **Data blijft bewaard** in een JSON-bestand op een Railway volume.

## Deployen op Railway (±5 min)

### 1. Code op GitHub
Maak een repo en push deze map (`macro-tracker`) ernaartoe:
```bash
cd macro-tracker
git init
git add .
git commit -m "Lean bulk tracker"
git branch -M main
git remote add origin https://github.com/JOUW-USER/lean-bulk-tracker.git
git push -u origin main
```

### 2. Railway-project
1. Ga naar [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → kies je repo.
2. Railway detecteert Node automatisch en draait `npm start`. Geen config nodig.

### 3. Persistent volume (zodat je data niet verdwijnt bij een redeploy)
1. In je service → tab **Variables** → voeg toe: `DATA_DIR` = `/data`
2. Tab **Settings** → **Volumes** → **New Volume** → mount path: `/data`

> Zonder volume werkt de app ook, maar dan reset je data bij elke nieuwe deploy. Het volume is dus belangrijk.

### 4. AI-feedback aanzetten (optioneel maar aanbevolen)
1. Haal een API-key op via [console.anthropic.com](https://console.anthropic.com) → **API Keys**.
2. Railway → **Variables** → voeg toe: `ANTHROPIC_API_KEY` = `sk-ant-...`
3. (Optioneel) `CLAUDE_MODEL` = `claude-sonnet-4-6` om het model te kiezen.

Zonder key werkt alles behalve de ingebouwde feedback-knop — dan gebruik je **Kopieer weekdata** en plak je het in een Claude-gesprek.

### 5. Domein
Railway → **Settings** → **Networking** → **Generate Domain**. Open die URL op je telefoon.

## Op je beginscherm zetten (als app)
- **iPhone (Safari):** deel-knop → *Zet op beginscherm*.
- **Android (Chrome):** menu → *App installeren* / *Toevoegen aan startscherm*.

Daarna opent 'ie fullscreen, zonder browserbalk, net als een echte app.

## Lokaal draaien (testen)
```bash
npm install
npm start
# open http://localhost:3000
```

## Targets aanpassen
Onderin de app onder **Targets aanpassen**. Standaard staan ze op: 3100 kcal · 160 g eiwit · 95 g vet · 400 g koolhydraten, start 72 kg, doel 80 kg. Pas ze aan wanneer je onderhoud of doel verandert.

## Tech
Node + Express, opslag in JSON op disk (geen database-setup, geen native dependencies — deployt in één keer). Frontend is één HTML-bestand met vanilla JS. Bewust simpel zodat het betrouwbaar draait en makkelijk aan te passen is.
