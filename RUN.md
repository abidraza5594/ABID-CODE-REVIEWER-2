# कैसे चलाएँ — Step by Step

बस ये steps follow करो। Windows PowerShell में।

---

## Step 1 — Prerequisites check (एक बार)

PowerShell खोलो और चलाओ:

```powershell
node --version
```

अगर error आए या version 20 से कम है, Node 20+ install करो: https://nodejs.org/en/download (LTS version)।

फिर pnpm install करो:

```powershell
npm install -g pnpm
pnpm --version
```

---

## Step 2 — Project folder में जाओ

```powershell
cd "c:\ABID\ABID CODE REVIEW 2"
```

---

## Step 3 — Dependencies install करो (पहली बार — slow, ~3–5 min)

```powershell
pnpm install
```

ये ts-morph, @angular/compiler, playwright, fastify, ioredis सब download करेगा। एक बार करना है, बाद में incremental होगा।

---

## Step 4 — Build करो

```powershell
pnpm build
```

> ⚠️ **पहली बार TypeScript errors आ सकती हैं।** मुझे बताओ क्या error आया (पूरा error copy-paste करो) और मैं fix कर दूँगा।

---

## Step 5 — Server चलाओ

```powershell
pnpm start
```

ये interactive prompt देगा:

```
  Abid Review — interactive PR analyzer
  Type a PR URL or number. Type "exit" to quit.

Enter PR URL or PR number (default: 13720) →
```

यहाँ पे आप तीन चीज़ें कर सकते हो:
- **Enter दबाओ** — default `13720` use करेगा (आपके `.env` में set है)
- **PR number type करो** — जैसे `12345`
- **पूरा URL paste करो** — जैसे `https://dev.azure.com/gharoffice/Leadrat-Black/_git/Leadrat-Black-Web/pullrequest/13720`

फिर ये सब करेगा automatically:

1. ADO से PR details fetch करेगा
2. Repo clone करेगा temp folder में (पहली बार slow — Leadrat-Black-Web बड़ा है)
3. TypeScript + Angular AST build करेगा
4. Angular rules चलाएगा (subscription leak, null guards, change detection, etc.)
5. Mistral को बोलेगा false positives filter करने को
6. Voice rewrite — comments को simple English में convert
7. Dedup — same issue multiple files में हो तो एक comment + siblings list
8. Terminal में दिखाएगा कि क्या-क्या post होगा
9. पूछेगा: `Post 5 comment(s) to ADO PR #13720? [y/N] →`
   - `y` दबाओ → ADO PR पे actually post हो जाएँगे
   - Enter / `n` → सिर्फ़ terminal में दिखाएगा, post नहीं करेगा (safe default)
10. फिर अगला PR मांगेगा। `exit` से बाहर निकलो।

---

## अगर कुछ टूटे

मुझे ये बताओ:
1. कौन सा step पर error आया
2. पूरा error message (PowerShell से copy-paste, screenshot नहीं)
3. command जो आपने चलाई थी

मैं fix कर दूँगा।

## Common issues जो likely आएँगी

**"Cannot find module '@abid/...'"** — `pnpm install` पूरी तरह नहीं हुई। फिर से चलाओ।

**TypeScript build errors** — मेरे code में बहुत बड़ा scaffold है, पहली compile में कुछ type mismatches हो सकती हैं। मुझे बताओ कौन सी file में, मैं fix करूँगा।

**ADO 401/403 error** — PAT key गलत है या scopes नहीं हैं। PAT में चाहिए:
- Code: Read & write
- Pull Request Threads: Read & write

**ADO 404 error** — Project name "Leadrat-Black" में spaces / case sensitivity issue। `.env` में exact name check करो।

**Mistral 401** — Key invalid। Console पे verify करो।

**Clone slow / fails** — Leadrat-Black-Web बड़ा repo है। पहली बार 1–3 min लग सकते हैं। `--filter=blob:none` use कर रहा हूँ ताकि shallow हो।
