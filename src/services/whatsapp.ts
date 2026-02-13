import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore,
    proto,
    WASocket,
    ConnectionState,
    Browsers,
    jidNormalizedUser
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'node:path';
import fs from 'node:fs';
import type { InstanceContext, WASocketLike } from '../types/whatsapp.js';

// ==============================================================================
// 0. INTERCEPTADOR NUCLEAR (MANTIDO)
// ==============================================================================
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function isGarbageLog(chunk: any): boolean {
    const line = String(chunk);
    return line.includes('Closing session:') || 
           line.includes('SessionEntry') || 
           line.includes('currentRatchet:') ||
           line.includes('chains:') ||
           line.includes('pendingPreKey:') ||
           line.includes('<Buffer') || 
           line.includes('ephemeralKeyPair') ||
           line.includes('noise processing');
}

// @ts-ignore
process.stdout.write = (chunk, encoding, callback) => {
    if (isGarbageLog(chunk)) return true; // Bloqueia o lixo
    return originalStdoutWrite(chunk, encoding, callback);
};

// @ts-ignore
process.stderr.write = (chunk, encoding, callback) => {
    if (isGarbageLog(chunk)) return true; // Bloqueia o lixo
    return originalStderrWrite(chunk, encoding, callback);
};

// Função para IMPRIMIR COM CERTEZA (Fura o bloqueio)
function safeLog(message: string) {
    originalStdoutWrite(message + '\n');
}

// ==============================================================================
// 1. CONFIGURAÇÕES E MOCKS
// ==============================================================================

interface DbAgendamento {
    cod_whats_mensagem: string;
    resposta_msg: string;
}

interface ExtendedMessageKey extends proto.IMessageKey {
    senderPn?: string;
}

const config = {
    markMessagesRead: false,
    webhookAllowedEvents: ['all', 'messages.upsert'],
};

const db = {
    getResposta: async (id: string): Promise<string | null> => { return null; },
    getMaxResposta: async (jid: string): Promise<DbAgendamento | null> => { return null; },
    setResposta: async (id: string, status: string) => { },
    setSair: async (jid: string) => { },
    setEntrar: async (jid: string) => { },
};

const logger = pino({ level: 'silent' });
const authLogger = pino({ level: 'silent' });
const instances = new Map<string, InstanceContext>();

// ==============================================================================
// 2. FUNÇÕES DE LOG DE MENSAGENS (COM CORES)
// ==============================================================================

function logTraffic(instanceName: string, direction: 'IN' | 'OUT', fromJid: string, toJid: string, text: string) {
    const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    
    // Limpeza dos números
    const cleanFrom = fromJid.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0];
    const cleanTo = toJid.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0];
    const cleanText = text.replace(/\n/g, ' ').substring(0, 60);

    // Definição de Cores ANSI
    const RESET = '\x1b[0m';
    const GREEN = '\x1b[32m'; // Para entrada
    const CYAN = '\x1b[36m';  // Para saída
    const YELLOW = '\x1b[33m'; // Para sistema

    if (direction === 'IN') {
        // 📥 Log de Entrada (VERDE)
        safeLog(`${GREEN}[${time}] [${instanceName}] 📥 RECEBIDO DE ${cleanFrom}: "${cleanText}"${RESET}`);
    } else {
        // 📤 Log de Saída (CIANO)
        safeLog(`${CYAN}[${time}] [${instanceName}] 📤 ENVIADO PARA ${cleanTo}: "${cleanText}"${RESET}`);
    }
}

async function replyWithLog(instanceName: string, sock: WASocket, toJid: string, text: string, quoted?: proto.IWebMessageInfo) {
    try {
        await sock.sendMessage(toJid, { text }, { quoted: quoted as any });
        
        const myJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : 'Bot';
        logTraffic(instanceName, 'OUT', myJid, toJid, text);
        
    } catch (error) {
        safeLog(`\x1b[31m[${instanceName}] ❌ ERRO AO ENVIAR: ${error}\x1b[0m`);
    }
}

function closeSocket(sock: InstanceContext['sock']): void {
    try {
        sock.ws?.close?.();
        if ('ev' in sock) { (sock as any).ev.removeAllListeners(); }
    } catch { }
}

export function getInstance(name: string): InstanceContext | undefined {
    return instances.get(name);
}

export function getAllInstances(): InstanceContext[] {
    return Array.from(instances.values());
}

async function SendWebhook(event: string, data: any, instanceKey: string) {
    // Implemente seu axios.post aqui
}

// ==============================================================================
// 3. LÓGICA DE NEGÓCIOS
// ==============================================================================

async function processarMensagemDeNegocio(instanceKey: string, sock: WASocket, msg: proto.IWebMessageInfo, m: any) {
    if (!msg.key || !msg.key.remoteJid) return;

    const l_key = msg.key as ExtendedMessageKey;
    const jid = l_key.remoteJid!;
    const isGroup = jid.endsWith('@g.us');
    
    let normalizedJid = jidNormalizedUser(jid);
    if (normalizedJid.includes('@lid') && l_key.senderPn) {
        normalizedJid = l_key.senderPn;
    }

    const myJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : 'Bot';
    const numeroPuro = normalizedJid.split('@')[0];

    // Ignora grupos e mensagens de protocolo
    if (!isGroup && !l_key.fromMe && (jid.includes("@s.whatsapp.net") || jid.includes("@lid"))) {
        
        const messageType = Object.keys(msg.message || {})[0];
        if (['protocolMessage', 'senderKeyDistributionMessage'].includes(messageType)) return;

        const webhookData: any = {
            key: instanceKey,
            ...msg,
            remetente: { ...sock.user, messageType, remoteJid: normalizedJid }
        };

        if (messageType === 'conversation') webhookData['text'] = m;

        // Extração de Texto
        let l_msg_resposta = "";
        let idBotao = "";
        let isButtonReply = false;

        if (msg.message?.conversation) {
            l_msg_resposta = msg.message.conversation.toLowerCase().trim();
        } else if (msg.message?.extendedTextMessage?.text) {
            l_msg_resposta = msg.message.extendedTextMessage.text.toLowerCase().trim();
        } else if (msg.message?.templateButtonReplyMessage) {
            idBotao = msg.message.templateButtonReplyMessage.selectedId || "";
            l_msg_resposta = (msg.message.templateButtonReplyMessage.selectedDisplayText || "").toLowerCase();
            isButtonReply = true;
        } else if (msg.message?.buttonsResponseMessage) {
             idBotao = msg.message.buttonsResponseMessage.selectedButtonId || "";
             l_msg_resposta = idBotao.toLowerCase(); 
             isButtonReply = true;
        }

        // >>> LOG DE ENTRADA <<<
        if (l_msg_resposta) {
            logTraffic(instanceKey, 'IN', normalizedJid, myJid, l_msg_resposta);
        }

        // Comandos Admin
        if (l_key.fromMe) {
            if (l_msg_resposta === "ia_on" || l_msg_resposta === "ia_off") {
                await sock.sendMessage(jid, { react: { text: '👍', key: l_key } });
                await SendWebhook('admin_command', webhookData, instanceKey);
            }
            return;
        }

        // --- RESPOSTAS AUTOMÁTICAS ---
        
        // 1. SAIR
        if (l_msg_resposta === "sair" || l_msg_resposta === "sair.") {
            await db.setSair(normalizedJid);
            await replyWithLog(instanceKey, sock, jid, "Você não receberá mais mensagens. Digite *QUEROENTRAR* para voltar.", msg);
            return;
        }

        // 2. ENTRAR
        if (l_msg_resposta === "queroentrar") {
            await db.setEntrar(normalizedJid);
            await replyWithLog(instanceKey, sock, jid, "Excelente! Você voltou.", msg);
            return;
        }

        // 3. CONFIRMAR

        
        // 3. CONFIRMAR
        const keywordsConfirm = ["confirmar", "Confirmar"];
        if (keywordsConfirm.some(k => l_msg_resposta.includes(k))) {
            
            // LOG DE TESTE: Para saber se ele entrou aqui
            console.log(`[DEBUG] Usuário ${normalizedJid} tentou CONFIRMAR.`);

            const retorno = await db.getMaxResposta(normalizedJid);
            
            if (!retorno) {
                // Se não achou no banco, avisa no terminal e responde algo genérico para testar
                console.log(`[DEBUG] Nenhum agendamento encontrado no banco para ${normalizedJid}`);
                await replyWithLog(instanceKey, sock, jid, "Você digitou confirmar, mas não encontrei nenhum agendamento pendente para este número.", msg);
            } else if (retorno.resposta_msg === "Cancelado") {
                await replyWithLog(instanceKey, sock, jid, "Oops! Não é possível confirmar um agendamento cancelado.", msg);
            } else {
                await replyWithLog(instanceKey, sock, jid, "Seu agendamento foi *CONFIRMADO* com sucesso! ✅", msg);
                const idParaSalvar = isButtonReply ? idBotao : retorno.cod_whats_mensagem;
                await db.setResposta(idParaSalvar, "Confirmado");
            }
            
            await SendWebhook('message', webhookData, instanceKey);
            return;
        }

        // 4. CANCELAR
        const keywordsCancel = ["cancelar", "Cancelar"];
        if (keywordsCancel.some(k => l_msg_resposta.includes(k))) {
            
            console.log(`[DEBUG] Usuário ${normalizedJid} tentou CANCELAR.`);

            const retorno = await db.getMaxResposta(normalizedJid);

            if (!retorno) {
                console.log(`[DEBUG] Nenhum agendamento encontrado para cancelar em ${normalizedJid}`);
                await replyWithLog(instanceKey, sock, jid, "Você digitou cancelar, mas não encontrei nenhum agendamento ativo.", msg);
            } else {
                await replyWithLog(instanceKey, sock, jid, "Seu agendamento foi *CANCELADO*. ❌", msg);
                const idParaSalvar = isButtonReply ? idBotao : retorno.cod_whats_mensagem;
                await db.setResposta(idParaSalvar, "Cancelado");
            }
            
            await SendWebhook('message', webhookData, instanceKey);
            return;
        }
        
        // 5. PING DE TESTE
        if (l_msg_resposta === "ping") {
            await replyWithLog(instanceKey, sock, jid, "Pong! 🏓", msg);
        }

        if (config.webhookAllowedEvents.includes('messages.upsert')) {
             await SendWebhook('message', webhookData, instanceKey);
        }
    }
}

// ==============================================================================
// 4. CONEXÃO E INICIALIZAÇÃO
// ==============================================================================

async function handleConnection(name: string, authFolder: string, update: Partial<ConnectionState>) {
    const { connection, lastDisconnect, qr } = update;
    const ctx = instances.get(name);
    if (!ctx) return;

    if (qr) {
        safeLog(`[${name}] 📷 Novo QR Code gerado.`);
        ctx.status = 'qr';
        ctx.qr = qr;
    }
    
    if (connection === 'open') {
        safeLog(`[${name}] ✅ Conexão estabelecida e pronta!`);
        ctx.status = 'connected';
        ctx.qr = null;
    }

    if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
            setTimeout(() => createInstance(name, authFolder).catch(() => {}), 100);
            return;
        }

        safeLog(`[${name}] 🔴 Desconectado (${statusCode}). Reconectar? ${shouldReconnect}`);
        ctx.status = 'disconnected';
        ctx.qr = null;

        if (statusCode === DisconnectReason.loggedOut) {
            disconnectInstance(name);
        } else if (shouldReconnect) {
            setTimeout(() => createInstance(name, authFolder).catch(console.error), 3000);
        }
    }
}

async function handleMessages(name: string, sock: WASocket, upsert: { messages: proto.IWebMessageInfo[], type: string }) {
    if (upsert.type !== 'notify') return;
    for (const msg of upsert.messages) {
        await processarMensagemDeNegocio(name, sock, msg, upsert);
    }
}








export async function createInstance(name: string, authFolder: string): Promise<{ ok: boolean; instance: string; error?: string }> {
    if (instances.has(name)) {
        const ctx = instances.get(name)!;
        if (ctx.status === 'connected') return { ok: true, instance: name };
        disconnectInstance(name);
    }
    try {
        const authPath = path.resolve(process.cwd(), authFolder, name);
        if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        let version: [number, number, number] = [2, 3000, 1015901307];
        try {
            const v = await fetchLatestWaWebVersion();
            version = v.version as [number, number, number];
        } catch {}

        const sock = makeWASocket({
            version,
            logger, 
            auth: { 
                creds: state.creds, 
                keys: makeCacheableSignalKeyStore(state.keys, authLogger) 
            },
            printQRInTerminal: false,
            browser: Browsers.macOS('Desktop'),
            syncFullHistory: false,
        });

        const ctx: InstanceContext = {
            name,
            sock: sock as unknown as WASocketLike,
            status: 'connecting',
            qr: null,
            createdAt: new Date(),
            authFolder,
        };
        instances.set(name, ctx);

        sock.ev.on('creds.update', saveCreds);
        // @ts-ignore
        sock.ev.on('connection.update', (u) => handleConnection(name, authFolder, u));
        sock.ev.on('messages.upsert', (m) => handleMessages(name, sock, m));

        return { ok: true, instance: name };
    } catch (error) {
        return { ok: false, instance: name, error: String(error) };
    }
}

export async function restoreSessions(authFolder: string): Promise<string[]> {
    const restored: string[] = [];
    const rootPath = path.resolve(process.cwd(), authFolder);
    if (!fs.existsSync(rootPath)) return restored;

    const items = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const item of items) {
        if (item.isDirectory() && fs.existsSync(path.join(rootPath, item.name, 'creds.json'))) {
            try { await createInstance(item.name, authFolder); restored.push(item.name); } 
            catch (err) { console.error(err); }
        }
    }
    return restored;
}

export function disconnectInstance(name: string): boolean {
    const ctx = instances.get(name);
    if (!ctx) return false;
    closeSocket(ctx.sock);
    instances.delete(name);
    return true;
}

export async function logoutInstance(name: string, authFolder: string): Promise<{ ok: boolean; error?: string }> {
    const ctx = instances.get(name);
    if (ctx?.sock.logout) try { await ctx.sock.logout(); } catch {}
    disconnectInstance(name);
    const authPath = path.resolve(process.cwd(), authFolder, name);
    try {
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
        return { ok: true };
    } catch (err) { return { ok: false, error: String(err) }; }
}

export function removeInstance(name: string): boolean {
    return disconnectInstance(name);
}