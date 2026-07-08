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

// Lista de modelos com visão (foto/PDF), em ordem de preferência. Cada um tem cota própria e
// separada dos outros — se um bater o limite (429/503), a função tenta o próximo da lista antes
// de esperar. Isso multiplica a capacidade efetiva em vez de depender de um único modelo.
const MODELOS_VISAO = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite'];
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
  // Estratégia: 429/503 no modelo principal -> tenta o alternativo na hora (tem cota própria, separada);
  // só espera de verdade se os dois estiverem no limite.
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
    const resp = await fetch(
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
    const data = await resp.json();
    return { status: resp.status, data };
  }

  // Extrai quantos segundos esperar a partir do erro 429 do Gemini (vem no campo "details" ou no texto da mensagem).
  function extrairEsperaSegundos(data){
    const detalhes = data?.error?.details || [];
    const retryInfo = detalhes.find(d => d['@type']?.includes('RetryInfo'));
    if (retryInfo?.retryDelay){
      const m = String(retryInfo.retryDelay).match(/([\d.]+)s/);
      if (m) return parseFloat(m[1]);
    }
    const msg = data?.error?.message || '';
    const m2 = msg.match(/retry in ([\d.]+)s/i);
    if (m2) return parseFloat(m2[1]);
    return 15; // fallback se não conseguir extrair
  }

  try {
    const resultados = [];
    // Tenta cada modelo da lista em ordem — cada um tem cota própria e separada.
    for (const modelo of MODELOS_VISAO){
      const r = await chamarGemini(modelo);
      if (r.status !== 429 && r.status !== 503) return res.status(r.status).json(r.data);
      resultados.push(r);
    }

    // Se TODOS os modelos estão no limite, agora sim espera o tempo pedido e tenta o principal mais uma vez
    const base = resultados.find(r => r.status === 429)?.data || resultados[0].data;
    const segundos = Math.min(extrairEsperaSegundos(base) + 1, 55);
    await espera(segundos * 1000);
    const rFinal = await chamarGemini(MODELOS_VISAO[0]);
    return res.status(rFinal.status).json(rFinal.data);
  } catch (e) {
    return res.status(502).json({ error: 'Falha ao chamar o Gemini: ' + e.message });
  }
};
