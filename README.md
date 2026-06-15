# Daily Log — 폰 푸시(앱 닫혀도 알림) 설치 가이드

앱을 닫아 둬도 매일 정한 시각에 폰으로 알림이 오게 하는 구성입니다.
구조: **다이어리(PWA) → 폰에 설치 → 서비스워커가 푸시 수신 / Cloudflare Worker가 매일 정한 시각에 푸시 발송.**

## 파일 구성
- `index.html` — 다이어리 본체 (※ `daily-log.html`을 **`index.html`로 이름 변경**해서 올리세요)
- `manifest.webmanifest` — 설치(홈 화면 추가)용
- `sw.js` — 서비스워커 (백그라운드 푸시 수신 + 알림 클릭 시 오늘 기록 열기)
- `icon-192.png`, `icon-512.png` — 앱 아이콘
- `worker.js` / `wrangler.toml` — Cloudflare Worker (구독 저장 + 매분 크론 발송)

정적 5개 파일(`index.html`, `manifest.webmanifest`, `sw.js`, 아이콘 2개)은 GitHub Pages에,
`worker.js`는 Cloudflare에 올립니다.

---

## 1) VAPID 키 생성
터미널에서 한 줄:
```
npx web-push generate-vapid-keys
```
출력된 **Public Key / Private Key**를 메모해 둡니다. (이 형식이 그대로 호환됩니다)

## 2) Cloudflare Worker 배포
```
# 작업 폴더에 worker.js, wrangler.toml 두고
npm i -g wrangler
wrangler login

# 구독 저장용 KV 만들기 → 출력된 id를 wrangler.toml의 id 자리에 붙여넣기
wrangler kv namespace create SUBS
```
`wrangler.toml` 편집:
- `id` = 위에서 받은 KV id
- `ALLOWED_ORIGIN` = 본인 GitHub Pages 주소 (예: `https://lnk111.github.io`)
- `VAPID_SUBJECT` = `mailto:본인메일`
- `VAPID_PUBLIC_KEY` = 1)에서 만든 **Public Key**

비밀키는 시크릿으로 등록 후 배포:
```
wrangler secret put VAPID_PRIVATE_KEY     # 1)의 Private Key 붙여넣기
wrangler deploy
```
배포되면 `https://daily-log-push.<서브도메인>.workers.dev` 주소가 나옵니다.

## 3) 다이어리에 주소 연결
`index.html` 상단 CONFIG 두 줄을 채웁니다:
```js
const WORKER_URL  = "https://daily-log-push.<서브도메인>.workers.dev";
const VAPID_PUBLIC = "<1)에서 만든 Public Key>";
```

## 4) GitHub Pages에 올리기
5개 파일을 같은 폴더(루트)에 두고 푸시 → 저장소 Settings → Pages에서 배포.
※ 같은 출처(같은 폴더)에 있어야 서비스워커가 동작합니다. HTTPS는 GitHub Pages가 기본 제공합니다.

## 5) 폰에서 켜기
**iPhone (필수 순서 — Apple 정책상 설치해야 푸시 가능):**
1. Safari로 사이트 열기 → **공유** → **홈 화면에 추가**
2. 홈 화면의 **Daily Log 앱 아이콘**으로 열기
3. 🔔 → 시간 설정 → **백그라운드 푸시 켜기** → 알림 허용

**Android (Chrome):** 사이트 열고 🔔 → 시간 설정 → **백그라운드 푸시 켜기** → 허용. (설치는 선택)

---

## 동작 확인
켠 직후 테스트하려면 알림 시간을 **현재보다 1~2분 뒤**로 맞춰 보세요. 크론이 매분 돌며
각 기기의 지정 시각(기기 시간대 기준)에 하루 한 번 발송합니다. 알림을 누르면 오늘 기록 화면이 열려요.

## 참고
- 앱이 열려 있을 때 울리는 기존 인앱 알림은 그대로 유지됩니다(푸시 미설정 기기의 대비책).
- 구독 정보는 Cloudflare KV에만 저장되고, 만료된 구독(404/410)은 자동 정리됩니다.
- 푸시 권한을 끄려면 🔔 패널의 **끄기**를 누르세요.
- iPhone은 "설치한 앱"에서만 푸시가 됩니다. 일반 Safari 탭에서는 푸시 옵션이 동작하지 않아요.
