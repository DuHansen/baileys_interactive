import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  createInstance,
  getInstance,
  getAllInstances,
  removeInstance,
  disconnectInstance,
  logoutInstance,
} from '../services/whatsapp.js';
import { config } from '../config.js';

const router = Router();

// Helper para esperar o QR Code ser gerado
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST /v1/instances
 * Cria uma nova instância.
 * Aguarda 2s para tentar retornar o QR Code já na primeira resposta.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { instance = 'main' } = req.body as { instance?: string };
    const name = String(instance).trim() || 'main';

    // 1. Inicia a criação
    const result = await createInstance(name, config.authFolder);

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    // 2. Espera um pouco para o socket conectar e gerar o QR Code
    // (O Baileys leva uns instantes para emitir o evento 'qr')
    await delay(2000);

    // 3. Busca o estado atual da instância na memória
    const ctx = getInstance(name);

    let qrBase64: string | undefined;
    
    // Verifica se o QR Code já está disponível no contexto (ctx) e não no result
    if (ctx && ctx.qr) {
      qrBase64 = await QRCode.toDataURL(ctx.qr, { width: 400, margin: 2 });
    }

    return res.json({
      ok: true,
      instance: name,
      status: ctx?.status ?? 'connecting',
      qr: qrBase64 ?? null,
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: message });
  }
});

/**
 * GET /v1/instances
 * Lista instâncias ativas e salvas (pastas em auth/).
 */
router.get('/', (_req: Request, res: Response) => {
  const list = getAllInstances().map((ctx) => ({
    instance: ctx.name,
    status: ctx.status,
    hasQr: Boolean(ctx.qr),
    createdAt: ctx.createdAt.toISOString(),
  }));

  let saved: string[] = [];
  // Usa config.authFolder (certifique-se que o nome da pasta bate com o config)
  const authDir = path.resolve(process.cwd(), 'auth'); 
  
  try {
    if (fs.existsSync(authDir)) {
      saved = fs.readdirSync(authDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    }
  } catch {
    saved = [];
  }

  return res.json({ ok: true, instances: list, saved });
});

/**
 * GET /v1/instances/saved
 * Lista apenas nomes das conexões salvas.
 */
router.get('/saved', (_req: Request, res: Response) => {
  const authDir = path.resolve(process.cwd(), 'auth'); // Ajuste se seu config usar outro nome
  let saved: string[] = [];
  try {
    if (fs.existsSync(authDir)) {
      saved = fs.readdirSync(authDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    }
  } catch {
    saved = [];
  }
  return res.json({ ok: true, saved });
});

/**
 * GET /v1/instances/:name/qr
 * Retorna o QR code da instância em base64 (se estiver em estado qr).
 */
router.get('/:name/qr', async (req: Request, res: Response) => {
  const { name } = req.params;
  const ctx = getInstance(name);
  
  if (!ctx) {
    return res.status(404).json({ ok: false, error: 'instance_not_found' });
  }
  
  // Se estiver conectado, não tem QR
  if (ctx.status === 'connected') {
     return res.status(400).json({ ok: false, error: 'already_connected', status: ctx.status });
  }

  if (!ctx.qr) {
    return res.status(400).json({ ok: false, error: 'qr_not_ready_yet', status: ctx.status });
  }

  const qrBase64 = await QRCode.toDataURL(ctx.qr, { width: 400, margin: 2 });
  return res.json({ ok: true, instance: name, qr: qrBase64 });
});

/**
 * GET /v1/instances/:name
 * Status de uma instância.
 */
router.get('/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  const ctx = getInstance(name);
  if (!ctx) {
    return res.status(404).json({ ok: false, error: 'instance_not_found' });
  }
  return res.json({
    ok: true,
    instance: ctx.name,
    status: ctx.status,
    hasQr: Boolean(ctx.qr),
    createdAt: ctx.createdAt.toISOString(),
  });
});

/**
 * POST /v1/instances/:name/disconnect
 * Desconecta e remove a instância da memória.
 */
router.post('/:name/disconnect', (req: Request, res: Response) => {
  const { name } = req.params;
  const removed = disconnectInstance(name);
  return res.json({ ok: removed, instance: name });
});

/**
 * POST /v1/instances/:name/logout
 * Logout + apaga pasta de auth.
 */
router.post('/:name/logout', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    // Ajuste o segundo parâmetro 'auth' se seu config.authFolder for diferente
    const result = await logoutInstance(name, 'auth'); 
    if (!result.ok) {
      return res.status(500).json({ ok: false, instance: name, error: result.error });
    }
    return res.json({ ok: true, instance: name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: message });
  }
});

/**
 * DELETE /v1/instances/:name
 * Remove a instância (alias para disconnect).
 */
router.delete('/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  const removed = removeInstance(name);
  return res.json({ ok: removed, instance: name });
});

export default router;