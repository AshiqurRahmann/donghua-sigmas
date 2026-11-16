# Donghua Sigmas: anime and donghua channel site

Ink-wash theme. Pages: Donate (donate.html), About (about.html), plus Join Discord buttons.
Styling: Tailwind CSS (compiled to css/tailwind.css) + css/custom.css.

## Run it
The site reads JSON files, so it must be served (not double-clicked).
- Local: `python -m http.server 8000` in this folder, then open http://localhost:8000
- Live: drag the folder onto https://app.netlify.com/drop (or GitHub Pages / Cloudflare Pages)

## Edit these files (all in /data)
- `config.json`: site name, uploader (`profile.name`, `handle`, `bio`, `avatar`), Discord/Telegram links, stats,
  monthly goal, payment methods (Boosty), sect ranks (donation tiers), cultivation `realms`, FAQ.
- `donors.json`: add a line after you verify a Discord screenshot (name, amount in USD, date, comment).
  The goal, realm, top 5 and donor wall update from it. Name "Anonymous" hides a donor.

## Assets
- Avatar: `img/avatar.jpeg`
- Logo & Favicon: `img/logo.jpeg`

## Styling
- `css/custom.css`: the hand-written look. `img/ink.svg`: the moon-and-mountains backdrop.
- `src/tailwind.css`: Tailwind entry and theme colors/fonts. After adding NEW Tailwind classes, rebuild:
  `npx @tailwindcss/cli -i src/tailwind.css -o css/tailwind.css --minify`
- Replace the placeholder portrait: drop your image in `img/` and set `profile.avatar` in config.json.
