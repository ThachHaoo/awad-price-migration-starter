# AI-LOG.md — IA#2

## 2026-10-14 — đọc đề và chọn cách làm (IA#2)
- Tool: Claude (claude.ai).
- Asked for: đối chiếu slide, đề Classroom, rubric và script của starter để tìm precondition và chỗ mâu thuẫn.
- Kept: `traffic.js` chỉ đọc `NEW_CLIENTS` một lần lúc khởi động, nên không thể vừa có một run liên tục vừa bật client mới sau khi API có `priceVnd`; backfill phải là script riêng vì mỗi migration chạy trong một transaction.
- Changed: AI khuyên dùng WSL; mình làm trên PowerShell, chỉ cần tắt server bằng Ctrl+C trong chính cửa sổ của nó.
- Rejected: một bản AI tự làm hết từ đầu tới cuối trong sandbox của nó (code, migration, bản nháp log). Mình bỏ toàn bộ để tự làm từng bước.
- By hand: quyết định sửa `traffic.js` để làm đúng rubric và khai báo việc sửa.

## 2026-10-14 — migration, backfill và code v2–v4 (IA#2)
- Tool: Claude Code viết theo prompt; Claude review diff.
- Asked for: `002`/`003` kèm `.down.sql`, `scripts/backfill.js`, và từng version v2 (ghi cả hai cột), v3 (đọc cột mới), v4 (chỉ dùng `price_vnd`).
- Kept: các file SQL, script backfill, code và test của v2–v4.
- Changed: không có
- Rejected: câu backfill trên slide (`WHERE price_vnd IS NULL`), vì nó bỏ sót những dòng v1 ghi đè sau khi v2 đã ghi (check-log step 2a: `disagree 166`). Cũng bỏ ý tưởng dùng trigger hoặc cho v4 ghi `price = NULL` để `check` ra CONSISTENT sau bước 5, vì như vậy làm mờ point of no return và vi phạm tiêu chí 6.
- By hand: test từng version với traffic trên một DB nháp, chạy các bản cũ và mới song song (v3 cùng v2, v4 cùng v3), và drop 003 trong lúc traffic đang chạy.

## 2026-10-14 — sửa công cụ của starter (IA#2)
- Tool: Claude chẩn đoán lỗi `migrate.js`; Claude Code viết phần `NEW_CLIENTS_FILE` cho `traffic.js`.
- Asked for: vì sao `migrate.js` lỗi `D:\D:\…` trên Windows; cách đổi tỉ lệ client mới khi traffic đang chạy mà không đụng vào logic đếm lỗi.
- Kept: phần đọc lại file mỗi giây và dòng log `new clients <cũ> -> <mới>`.
- Changed: viết rõ regex BOM thành `/^\uFEFF/`, đổi comment ví dụ sang `Set-Content -Encoding ascii`
- Rejected: không có.
- By hand: sửa `migrate.js` dùng `fileURLToPath` (commit `a4337f6`).

## 2026-10-14 — chạy chính thức (IA#2)
- Tool: Claude soạn runbook theo từng bước.
- Asked for: thứ tự restart và migration cho một run liên tục, sao cho không áp bước sau quá sớm.
- Kept: worktree `base` (chỉ có migration 001); chạy migration của mỗi bước từ worktree của đúng version đó.
- Changed: lần đầu traffic chạy bằng `npm run traffic` và bị kill khi Ctrl+C trên Windows, không ra `RESULT`. Mình chạy lại từ đầu bằng `node scripts\traffic.js`.
- Rejected: không có.
- By hand: toàn bộ lần chạy (10 lần restart, mỗi lần một instance; backfill; rollback v3 → v2 → v3; down-test). Kết quả: `RESULT: zero failed requests`.

## 2026-10-14 — MIGRATION.md và tự chấm (IA#2)
- Tool: Claude Code viết bản đầu; Claude sửa.
- Asked for: bảng kế hoạch theo tiêu chí 1, cùng số dòng bằng chứng lấy từ log.
- Kept: bảng, phần point of no return, rollback, backfill.
- Changed: cột "version còn chạy an toàn" bị thiếu chính version đang chạy; hướng dẫn chạy lại chưa khớp với cách đã chạy thật.
- Rejected: không có.
- By hand: đối chiếu số dòng với `traffic-log.txt`; điểm claim cho từng tiêu chí.
