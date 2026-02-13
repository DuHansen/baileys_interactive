import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import instancesRouter from './routes/instances.js';
import messagesRouter from './routes/messages.js';
import { restoreSessions } from './services/whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '2mb' }));

function apiKeyMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.headers['x-api-key'];
  if (!config.apiKey || config.apiKey === '') {
    return next();
  }
  if (key !== config.apiKey) {
    return res.status(401).json({ ok: false, error: 'invalid_api_key' });
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'SimplesAgenda' });
});

// API key só nas rotas /v1 (a interface em / carrega sem key)
app.use('/v1/instances', apiKeyMiddleware, instancesRouter);
app.use('/v1/messages', apiKeyMiddleware, messagesRouter);

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));



// Adicione o 'async' aqui antes dos parâmetros ()
app.listen(config.port, async () => { 
  console.log(`[SimplesAgenda] API rodando em http://localhost:${config.port}`);
  console.log(`[SimplesAgenda] Interface: http://localhost:${config.port}`);
  
  if (config.apiKey) {
    console.log('[SimplesAgenda] API Key ativa. Use header: x-api-key');
  }

  // Lógica de Restauração
  try {
    // Como você mencionou uma pasta 'auth' na sua estrutura, 
    // certifique-se que o nome aqui coincide com a pasta onde o Baileys salva as sessões.
    const authFolder = 'auth'; 
    
    console.log(`[SimplesAgenda] Iniciando restauração de sessões...`);
    const restored = await restoreSessions(authFolder);
    
    if (restored.length > 0) {
      console.log(`[SimplesAgenda] 🎉 ${restored.length} sessões restauradas: ${restored.join(', ')}`);
    } else {
      console.log(`[SimplesAgenda] Nenhuma sessão encontrada para restaurar em ./${authFolder}`);
    }
  } catch (error) {
    console.error(`[SimplesAgenda] Erro crítico na restauração:`, error);
  }
});