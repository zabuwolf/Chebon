# Bon · Chè & Tào Phớ — Web đặt món qua QR

Khách quét mã QR trên bàn → nhập tên + SĐT → chọn món → đặt. Chủ quán mở trang `/admin` để nhận đơn ngay lập tức (có chuông báo), tính tiền và xem doanh thu.

## Chạy thử trên máy

Cần Node.js 22.13 trở lên.

```bash
npm install
npm start
```

- Trang khách: http://localhost:3000 (thêm `?ban=5` để giả lập quét QR bàn 5)
- Trang chủ quán: http://localhost:3000/admin — mật khẩu mặc định `bon123`

## Cấu hình (biến môi trường)

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `ADMIN_PASSWORD` | Mật khẩu trang chủ quán. **Bắt buộc đổi khi chạy thật.** | `bon123` |
| `SESSION_SECRET` | Chuỗi ngẫu nhiên dài để giữ đăng nhập qua các lần khởi động lại | tạo ngẫu nhiên mỗi lần chạy |
| `PUBLIC_URL` | Địa chỉ web thật, dùng để in mã QR (VD `https://bonche.vn`) | lấy theo địa chỉ đang truy cập |
| `PORT` | Cổng chạy server | `3000` |
| `DATA_DIR` | Thư mục lưu database `bon.db` | `./data` |

## Chủ quán dùng thế nào

- **Đơn hàng**: đơn mới hiện màu cam, có chuông + rung. Bấm *Nhận đơn* → *Xong món* → *Tính tiền*. Nút *Tính tiền* gộp tất cả đơn chưa trả của cùng một bàn thành một hoá đơn. Lần đầu mở trang hãy bấm **🔔 Bật chuông** (trình duyệt chặn âm thanh cho đến khi bạn chạm vào màn hình).
- **Doanh thu**: hôm nay / hôm qua / 7 ngày / tháng này / tháng trước hoặc tự chọn ngày. Chỉ tính các đơn đã thu tiền. Có biểu đồ theo ngày và danh sách món bán chạy.
- **Thực đơn**: sửa tên, giá (đơn vị nghìn), gạt công tắc khi hết món, thêm hoặc xoá món.
- **Mã QR**: nhập số bàn rồi bấm *In mã QR*. Có thêm một mã "Mang về" không gắn số bàn.

Khách đặt xong có thể theo dõi trạng thái đơn và tự huỷ khi quán chưa nhận.

## Đưa lên mạng

Dữ liệu nằm trong file SQLite `data/bon.db`, nên cần chỗ chạy có **ổ đĩa lưu lâu dài**:

- **VPS** (khoảng 100–150k/tháng): cài Node, chạy bằng `pm2`, đặt Nginx + HTTPS phía trước.
- **Railway / Fly.io**: nhớ gắn volume và trỏ `DATA_DIR` vào volume đó.
- **Máy tính ở quán + Cloudflare Tunnel**: miễn phí, nhưng máy phải luôn bật.

Sau khi có tên miền thật, đặt `PUBLIC_URL` rồi vào tab **Mã QR** để in lại mã.

Sao lưu: chỉ cần copy file `data/bon.db` (nên làm khi server tạm dừng).
