import type { WASocket, AnyMessageContent, proto } from '@whiskeysockets/baileys';

/**
 * Tipos para o socket InfiniteAPI/Baileys.
 * * WASocketLike combina a tipagem oficial do Baileys com as extensões
 * personalizadas (Native Buttons, Lists, Carousel) que você utiliza.
 */

export interface InstanceContext {
  name: string;
  sock: WASocketLike;
  status: 'connecting' | 'connected' | 'disconnected' | 'qr';
  qr: string | null;
  createdAt: Date;
  authFolder: string;
}

/**
 * Aqui acontece a mágica:
 * Pegamos o WASocket oficial e sobrescrevemos o método 'sendMessage' 
 * para aceitar seus tipos personalizados (CustomMessageContent).
 */
export type WASocketLike = Omit<WASocket, 'sendMessage'> & {
  sendMessage: (
    jid: string, 
    content: AnyMessageContent | CustomMessageContent, // Aceita o padrão E o customizado
    options?: any
  ) => Promise<proto.IWebMessageInfo | undefined>;
};

// --- Interfaces dos Botões e Listas Nativos ---

export interface NativeButtonReply {
  type: 'reply';
  id: string;
  text: string;
}

export interface NativeButtonUrl {
  type: 'url';
  text: string;
  url: string;
}

export interface NativeButtonCopy {
  type: 'copy';
  text: string;
  copyText: string;
}

export interface NativeButtonCall {
  type: 'call';
  text: string;
  phoneNumber: string;
}

export type NativeButton = NativeButtonReply | NativeButtonUrl | NativeButtonCopy | NativeButtonCall;

export interface NativeListRow {
  id: string;
  title: string;
  description?: string;
}

export interface NativeListSection {
  title: string;
  rows: NativeListRow[];
}

export interface NativeCarouselCard {
  title?: string;
  body?: string;
  footer?: string;
  image?: { url: string };
  imageUrl?: string;
  buttons?: Array<{ type?: string; id: string; text: string }>;
}

/**
 * Conteúdo personalizado que não existe no Baileys oficial,
 * mas existe na sua implementação (InfiniteAPI/Fork).
 */
export interface CustomMessageContent {
  text?: string;
  footer?: string;
  nativeButtons?: NativeButton[];
  nativeList?: {
    buttonText: string;
    sections: NativeListSection[];
  };
  nativeCarousel?: {
    cards: NativeCarouselCard[];
  };
  poll?: {
    name: string;
    values: string[];
    selectableCount?: number;
  };
  pollCreationMessage?: {
    name: string;
    options: Array<{ optionName: string }>;
    selectableOptionsCount?: number;
  };
  // Permite outros campos caso a API mude
  [key: string]: unknown;
}