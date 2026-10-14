# IA#2 — Đổi giá sang `price_vnd` không downtime

Mục tiêu: chuyển `menu_items.price` (REAL, nghìn đồng, `45.5` = 45.500 đ) sang
`menu_items.price_vnd` (INTEGER, đồng). Làm theo expand → migrate → contract,
với hai instance A (`:3001`) và B (`:3002`) dùng chung một file DB và traffic chạy suốt.

## Kế hoạch

| Bước | Schema sau bước | Code trên mọi instance (tag) | Lệnh undo chính xác | Version cũ còn chạy an toàn |
|---|---|---|---|---|
| 0 khởi đầu | `001`: `id, name, price` | v1 | — | v1 |
| 1 expand `002` | `+ price_vnd INTEGER` nullable, CHECK NULL hoặc số nguyên > 0 | v1 | `npm run migrate:down` (revert `002`) | v1 |
| 2 v2 write both | như bước 1 | v2 — ghi cả `price` và `price_vnd`, đọc `price`, trả thêm `priceVnd` | redeploy từng instance về `v1` | v1, v2 (dòng lệch do v1 ghi sẽ được backfill sửa) |
| 3 backfill | như bước 1, `price_vnd` không còn NULL | v2 | không cần (chỉ điền dữ liệu, `price` không đổi) | v1, v2 (nếu quay về v1 thì phải chạy lại backfill trước khi lên v3) |
| 4 v3 read new | như bước 3 | v3 — đọc `price_vnd`, vẫn ghi cả hai cột | redeploy từng instance về `v2` | v2, v3 |
| 5 v4 new only ⚠ | như bước 3, `price` ngừng được cập nhật | v4 — không đọc, không ghi `price` | redeploy từng instance về `v3` (**không** về `v2`) | v3, v4 |
| 6 contract `003` | `003`: `id, name, price_vnd` | v4 | `npm run migrate:down` (revert `003`, tính lại `price` từ `price_vnd`) | v4; sau khi down: v3 hoặc v4 |

Redeploy = dừng một instance (server xử lý xong request đang chạy), khởi động lại
nó từ worktree của tag kia, chờ nó lên rồi mới làm instance thứ hai. Traffic ghi
instance đang tắt là `rerouted`, không tính là lỗi.

Thứ tự migration và code: expand (`002`) chạy **trước** khi bất kỳ instance nào
lên v2, vì v2 crash ngay lúc khởi động nếu chưa có cột `price_vnd` (đã gặp khi thử).
Contract (`003`) chạy **sau** khi v4 đã chạy trên cả A và B.

## Point of no return: bước 5

Từ v4, không code nào cập nhật `price` nữa: dòng mới có `price` NULL, dòng bị
PATCH giữ giá cũ. v1/v2 đọc `price`, nên nếu quay về chúng thì API vẫn trả
**200 nhưng với giá cũ**, và tính tiền đơn hàng theo giá đó. Đây là lỗi im lặng,
health check không bắt được. Muốn quay lại v2 thì phải tính lại `price` từ
`price_vnd`. Việc đó là **một migration mới**, không phải undo. Undo hợp lệ duy
nhất của bước 5 là về v3, vì v3 đọc `price_vnd` nên thấy được mọi thứ v4 đã ghi.

**Vì sao `check` báo INCONSISTENT sau bước 5** (`disagree 1527` trong check-log):
`check.js` so `price_vnd` với `round(price*1000)` khi cả hai cột còn tồn tại. v4
PATCH chỉ đổi `price_vnd`, nên mọi dòng bị re-price sau bước 5 đều bị đếm là
lệch. Dòng mới có `price` NULL thì so sánh ra NULL, nên không bị đếm. Đây là
trạng thái đã biết trước, không phải hỏng dữ liệu: nguồn đúng lúc này là
`price_vnd`. Cảnh báo này tự hết ở bước 6, vì khi `price` bị drop thì `check`
không so nữa (check-log bước 6: CONSISTENT).

## Rollback dưới traffic: v3 → v2 → v3

Đã làm trên cả A và B khi traffic đang chạy (check-log: `rollback` rồi `roll forward`, cả hai đều CONSISTENT, `disagree 0`).

- **An toàn vì:** v3 vẫn ghi cả hai cột, nên khi về v2 thì `price` mà v2 đọc
  luôn mới nhất. v2 cũng ghi cả hai cột, nên khi lên lại v3 thì `price_vnd` cũng
  không bị cũ. Trong lúc A và B chạy lẫn hai version, mỗi lần ghi đều giữ hai cột
  khớp nhau.
- **Không an toàn:** v4 → v2 (lý do ở phần trên), và v3 → v1. v1 chỉ ghi `price`,
  nên `price_vnd` mà v3 đọc sẽ bị cũ.

## Backfill (`scripts/backfill.js`)

- **Điều kiện là `price IS NOT NULL AND (price_vnd IS NULL OR price_vnd <> CAST(round(price*1000) AS INTEGER))`,
  không chỉ `price_vnd IS NULL`.** Trong lúc A đã lên v2 mà B còn v1, v1 PATCH
  ghi đè `price` lên những dòng v2 đã ghi, và để nguyên `price_vnd` cũ. Những
  dòng đó có `price_vnd` khác NULL nhưng sai. Check-log cho thấy điều này:
  `disagree 166` ở step 2a (A=v2, B=v1) và `97` ở step 2. Chỉ lọc NULL thì sẽ bỏ
  sót những dòng này. Điều kiện hiện tại sửa được chúng, và chạy lại script nhiều
  lần cũng an toàn (sau backfill: `disagree 0`, `price_vnd_null 0`).
- Mỗi batch 500 dòng (`BATCH`), nằm trong một `BEGIN IMMEDIATE … COMMIT` riêng,
  rồi nghỉ 50 ms (`PAUSE_MS`). Nhờ vậy khoá ghi chỉ bị giữ trong một batch, và
  request ghi của A/B chen vào được giữa các batch. Ctrl+C thì dừng sau batch
  đang chạy.
- **Chỉ chạy sau khi B đã lên v2** (mọi instance là v2). Nếu còn v1 chạy, dòng
  nó ghi sau khi backfill đi qua sẽ lại lệch.

## Thay đổi công cụ của starter

- **(a) `scripts/migrate.js`:** đường dẫn thư mục migrations đổi sang dùng
  `fileURLToPath(new URL('../migrations/', import.meta.url))` để chạy được trên
  Windows. Commit `a4337f6`, ngay sau tag `v1`.
- **(b) `scripts/traffic.js`:** thêm `NEW_CLIENTS_FILE`. Script đọc lại file này
  mỗi giây và đổi tỉ lệ client mới mà không cần restart, rồi ghi log
  `new clients <cũ> -> <mới>`. Lý do: rubric yêu cầu **một** lần chạy traffic
  liên tục, mà client mới (gửi và đòi `priceVnd`) chỉ được bật sau khi API đã có
  `priceVnd`. Bản gốc chỉ đọc `NEW_CLIENTS` một lần lúc khởi động. Logic đếm
  ok/error/contract/stale/unavailable/rerouted giữ nguyên. Commit `76ec176`.

## Cách chạy lại

Mỗi version có một worktree (detached HEAD):

```
../ia2-wt/base  a4337f6  sửa migrate.js, chỉ có migration 001
../ia2-wt/v1    v1
../ia2-wt/v2    v2   (có 001, 002)
../ia2-wt/v3    v3
../ia2-wt/v4    v4   (chưa có 003)
```

- Đặt `DB_PATH` thành đường dẫn **tuyệt đối** tới `ia2/data/app.db` cho mọi
  terminal, để mọi version dùng cùng một file DB.
- Migration của mỗi bước chạy bằng `node ../ia2-wt/<ver>/scripts/migrate.js up`.
  `up` áp mọi migration còn pending, nên dùng worktree của đúng version sẽ không
  áp bước sau quá sớm. Bước 0 dùng `base` (chỉ `001`), bước 1 dùng `v2` (`002`),
  bước 6 dùng `node scripts/migrate.js up` trên `main` (`003`).
- Thứ tự giống check-log: 0 → 1 → 2a (A=v2) → 2 (B=v2) → 3 backfill → 4 v3 →
  rollback v3→v2 → roll forward v2→v3 → 5 v4 → 6 `003`. Sau mỗi bước chạy
  `node scripts/check.js` và ghi nối kết quả vào `check-log.txt`, kèm nhãn bước và giờ.
- Traffic chạy một lần suốt từ bước 0, từ thư mục chính:
  `NEW_CLIENTS_FILE=data/nc.txt node scripts/traffic.js`, với `data/nc.txt` = `0`
  lúc bắt đầu. Sau bước 2 (mọi instance đã trả `priceVnd`) ghi `0.3` vào file
  (traffic-log dòng 20). Chạy `node` trực tiếp, không qua `npm run`: trên Windows,
  Ctrl+C qua `npm` kill thẳng script nên không ra được dòng `FINAL`/`RESULT`.
- Down-test chạy trên một file DB riêng (`data\downtest.db`): `002` up/down và
  `003` up/down, xem cuối check-log.

## Bằng chứng

| Mục | Ở đâu |
|---|---|
Traffic bắt đầu lúc 19:21:37.7 (giờ máy, `12:21:37.7Z`); giờ trong `check-log.txt` là giờ máy.

| Mục | `traffic-log.txt` | `check-log.txt` |
|---|---|---|
| Một lần chạy liên tục | dòng 2 → 76 | |
| Expand `002` khi v1 đang chạy | dòng 2–9, không lỗi | `step 1` |
| Rolling v1 → v2 (A rồi B) | dòng 10–11, 15–16 | `step 2a`, `step 2` |
| Bật client mới | dòng 20 (`new clients 0 -> 0.3`) | |
| Backfill khi có traffic | dòng 20–27, không lỗi | `step 3 - after backfill`: CONSISTENT |
| Rolling v2 → v3 | dòng 28–33 | `step 4` |
| Rollback v3 → v2 | dòng 37–44 | `rollback`: CONSISTENT |
| Roll forward v2 → v3 | dòng 48–54 | `roll forward`: CONSISTENT |
| Rolling v3 → v4 (point of no return) | dòng 59–65 | `step 5`: INCONSISTENT, đúng như dự kiến |
| Drop `003` khi v4 đang chạy | dòng 65–74, không lỗi | `step 6`: CONSISTENT |
| Mỗi lần restart chỉ một instance (`down` → `back`, không chồng nhau) | dòng 10–65 | |
| FINAL + `RESULT: zero failed requests` | dòng 75–76 | |
| `migrate:down` của `002` và `003` | | phần `down-test` |
| Commit/tag theo bước | `git log --oneline --decorate` | |
