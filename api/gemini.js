const admin = require('firebase-admin');

// Inicializa o Firebase Admin uma única vez (variáveis vêm do Vercel, nunca do navegador).
// Isso fica num try/catch pra que, se a chave estiver mal formatada, a função responda
// com um erro claro em vez de simplesmente cair (o que aparecia como "503 Service Unavailable").
let initError = null;
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // No Vercel, cole a chave com \n literais — aqui a gente converte de volta pra quebra de linha real.
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  } catch (e) {
    initError = e.message;
  }
}

const GEMINI_MODEL_PRIMARY = 'gemini-3.5-flash';
const GEMINI_MODEL_FALLBACK = 'gemini-2.5-flash'; // usado só se o principal continuar sobrecarregado
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  // 0) Confere se as variáveis de ambiente básicas existem e se o Admin inicializou.
  const faltando = [];
  if (!process.env.FIREBASE_PROJECT_ID) faltando.push('FIREBASE_PROJECT_ID');
  if (!process.env.FIREBASE_CLIENT_EMAIL) faltando.push('FIREBASE_CLIENT_EMAIL');
  if (!process.env.FIREBASE_PRIVATE_KEY) faltando.push('FIREBASE_PRIVATE_KEY');
  if (!process.env.GEMINI_API_KEY) faltando.push('GEMINI_API_KEY');
  if (faltando.length) {
    return res.status(500).json({ error: 'Variáveis de ambiente faltando no Vercel: ' + faltando.join(', ') });
  }
  if (initError) {
    return res.status(500).json({ error: 'Falha ao inicializar o Firebase Admin (confira o formato da FIREBASE_PRIVATE_KEY): ' + initError });
  }

  // 1) Confere se quem está chamando está logado no app (token do Firebase Auth).
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token ausente — faça login no app.' });

  try {
    await admin.auth().verifyIdToken(token);
  } catch (e) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada — faça login novamente: ' + e.message });
  }

  // 2) Recebe o arquivo (PDF ou foto, já em base64) e o prompt vindos do app.
  const { base64, mimeType, prompt } = req.body || {};
  if (!base64 || !mimeType || !prompt) {
    return res.status(400).json({ error: 'Parâmetros faltando (base64, mimeType ou prompt).' });
  }

  // 3) Repassa pro Gemini usando a chave que só o servidor conhece.
  // Se responder 503 (sobrecarregado), tenta de novo com espera curta; se persistir, troca de modelo.
  const body = JSON.stringify({
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64 } },
        { text: prompt },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json' },
  });

  const espera = (ms) => new Promise(r => setTimeout(r, ms));

  async function chamarGemini(modelo){
    return fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body,
      }
    );
  }

  try {
    let ultimaResposta, ultimoStatus;

    // até 2 tentativas no modelo principal
    for (let tentativa = 0; tentativa < 2; tentativa++){
      const geminiResp = await chamarGemini(GEMINI_MODEL_PRIMARY);
      const data = await geminiResp.json();
      if (geminiResp.status !== 503) return res.status(geminiResp.status).json(data);
      ultimaResposta = data; ultimoStatus = geminiResp.status;
      await espera(1500 * (tentativa + 1)); // 1.5s, depois 3s
    }

    // se continuou sobrecarregado, tenta 1 vez no modelo alternativo
    const geminiRespFallback = await chamarGemini(GEMINI_MODEL_FALLBACK);
    const dataFallback = await geminiRespFallback.json();
    if (geminiRespFallback.status !== 503) return res.status(geminiRespFallback.status).json(dataFallback);

    return res.status(503).json(dataFallback || ultimaResposta);
  } catch (e) {
    return res.status(502).json({ error: 'Falha ao chamar o Gemini: ' + e.message });
  }
};
