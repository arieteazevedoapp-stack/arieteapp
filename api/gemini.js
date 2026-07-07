const admin = require('firebase-admin');

// Inicializa o Firebase Admin uma única vez (variáveis vêm do Vercel, nunca do navegador).
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // No Vercel, cole a chave com \n literais — aqui a gente converte de volta pra quebra de linha real.
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const GEMINI_MODEL = 'gemini-3.5-flash';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  // 1) Confere se quem está chamando está logado no app (token do Firebase Auth).
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token ausente — faça login no app.' });

  try {
    await admin.auth().verifyIdToken(token);
  } catch (e) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada — faça login novamente.' });
  }

  // 2) Recebe o arquivo (PDF ou foto, já em base64) e o prompt vindos do app.
  const { base64, mimeType, prompt } = req.body || {};
  if (!base64 || !mimeType || !prompt) {
    return res.status(400).json({ error: 'Parâmetros faltando (base64, mimeType ou prompt).' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor.' });
  }

  // 3) Repassa pro Gemini usando a chave que só o servidor conhece.
  try {
    const geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType, data: base64 } },
              { text: prompt },
            ],
          }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    );
    const data = await geminiResp.json();
    return res.status(geminiResp.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Falha ao chamar o Gemini: ' + e.message });
  }
};
