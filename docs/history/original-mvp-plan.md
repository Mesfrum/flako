# 📄 Shrib Clone MVP – End-to-End Encryption + Auto-Save

## 🎯 Goal

Build a minimal Shrib clone focused on:

- ✅ End-to-End Encryption (E2EE)
- ✅ Auto-save (locally & remotely)
- ❌ No real-time collaboration (yet)
- ❌ No login system

---

## 🚀 Features

| Feature                | Description                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| **Text Editor**        | Simple textarea or markdown editor                                                   |
| **Auto-Save (Local)**  | Save to `localStorage` or `IndexedDB` every few seconds                              |
| **Auto-Save (Remote)** | Push encrypted data to Go backend                                                    |
| **E2E Encryption**     | Done entirely in browser using AES-GCM                                               |
| **URL-Based Doc ID**   | Format: `/#docid:base64key`                                                          |
| **Fetch & Decrypt**    | On page load, fetch encrypted blob and decrypt using key from `window.location.hash` |

---

## 🔐 Encryption Workflow (Client-Side)

### 1. Generate AES Key

```js
const key = crypto.getRandomValues(new Uint8Array(32)); // 256-bit key
```

### 2. Encrypt Before Saving

```js
const enc = new TextEncoder();
const iv = crypto.getRandomValues(new Uint8Array(12)); // AES-GCM IV
const ciphertext = await crypto.subtle.encrypt(
  { name: "AES-GCM", iv },
  cryptoKey,
  enc.encode(text)
);
```

### 3. Decrypt on Load

```js
const decrypted = await crypto.subtle.decrypt(
  { name: "AES-GCM", iv },
  cryptoKey,
  ciphertext
);
const text = new TextDecoder().decode(decrypted);
```

> 💡 Store key in URL fragment (`#docid:base64key`) and extract it client-side only.

---

## 🌐 API Design (Go Backend)

| Endpoint   | Method | Description          |
| ---------- | ------ | -------------------- |
| `/doc/:id` | GET    | Fetch encrypted blob |
| `/doc/:id` | PUT    | Save encrypted blob  |

### Example Document Schema (Go)

```go
type Document struct {
    ID        string    `json:"id"`
    Ciphertext []byte   `json:"ciphertext"`
    IV        []byte    `json:"iv"`
    UpdatedAt time.Time
}
```

---

## 💾 Auto-Save Logic (Frontend)

```js
setInterval(() => {
  const text = editor.value;
  saveLocally(text);
  encryptAndUpload(text); // PUT to backend
}, 5000); // every 5s
```

---

## 📁 Local Save Strategy

- Store in: `localStorage["doc:<id>"] = encrypted_blob`
- Load from localStorage first, then from remote

---

## 🗂️ Suggested Project Structure

```
/flako/
├── frontend/
│   ├── index.html
│   ├── app.js         # editor + crypto
├── backend/
│   ├── main.go        # HTTP server
│   ├── store.go       # in-memory or SQLite
```

---

## ✅ MVP Complete When:

- [ ] Editor is functional
- [ ] Text is encrypted before sending
- [ ] Text auto-saves locally + remotely
- [ ] Decryption works from shared URL
- [ ] Clean error handling & fallback

---

## 🛠️ Future Enhancements (Post-MVP)

- Real-time collaboration (CRDT or OT + WebSocket)
- Password-protected documents
- Offline-first + PWA
- Rich text or Markdown preview
