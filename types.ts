
export enum GameState {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  PLAYING = 'PLAYING',
  FINISHED = 'FINISHED'
}

export interface GestureChallenge {
  emoji: string;
  name: string;
  description: string;
}

export const GESTURES: GestureChallenge[] = [
  { emoji: '✌️', name: '剪刀手', description: '伸出食指和中指' },
  { emoji: '👍', name: '点赞', description: '竖起大拇指' },
  { emoji: '👌', name: 'OK', description: '食指和大拇指成圈' },
  { emoji: '🖐️', name: '击掌', description: '张开五指' },
  { emoji: '🫶', name: '比心', description: '双手或单手组成爱心' },
  { emoji: '✊', name: '加油', description: '握紧拳头' }
];
