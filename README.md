# Prana Homeo Care Backend

This backend handles:

- Appointment slot checking
- Slot locking / double-booking prevention
- Admin bookings table
- CSV download for bookings
- Patient feedback submission
- Latest feedback display API
- Feedback likes
- Admin feedback review
- Admin feedback delete
- Total feedback count

## Local setup

```bash
npm install
npm start
```

Test:

```txt
http://localhost:3000
http://localhost:3000/api/slots?date=2026-06-25
http://localhost:3000/admin.html
```

## Railway Variables

Add these in Railway service variables:

```env
ADMIN_TOKEN=yourStrongAdminPassword
DATA_FILE=/data/prana-data.json
ALLOWED_ORIGIN=*
```

Use a Railway Volume mounted at:

```txt
/data
```

This keeps bookings and feedbacks after redeploys/restarts.

## Current appointment slots

Monday to Saturday:

```txt
5:00 PM, 5:30 PM, 6:00 PM, 6:30 PM, 7:00 PM, 7:30 PM, 8:00 PM, 8:30 PM
```

Sunday:

```txt
Prior appointment only
```

## Public APIs

```txt
GET  /api/slots?date=YYYY-MM-DD
POST /api/bookings
GET  /api/feedbacks?limit=3
POST /api/feedbacks
POST /api/feedbacks/:id/like
```

## Admin APIs

All admin APIs require either header:

```txt
x-admin-token: yourStrongAdminPassword
```

or query:

```txt
?token=yourStrongAdminPassword
```

```txt
GET    /api/admin/bookings
GET    /api/admin/bookings.csv
GET    /api/admin/feedbacks
DELETE /api/admin/feedbacks/:id
GET    /api/admin/feedbacks.csv
GET    /api/admin/stats
```

## Admin page

The backend includes:

```txt
public/admin.html
```

After deployment, open:

```txt
https://your-backend.up.railway.app/admin.html
```

Use the value from `ADMIN_TOKEN` as the password.

## Website feedback connection

To make feedbacks appear for everyone publicly, your main website must submit reviews to:

```txt
POST /api/feedbacks
```

and load latest 3 from:

```txt
GET /api/feedbacks?limit=3
```

Likes should call:

```txt
POST /api/feedbacks/:id/like
```

Use frontend localStorage to prevent the same browser from liking the same feedback again.
