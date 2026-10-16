import { randomInt } from 'node:crypto';
const MEMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I
export const newMemberCode = () => 'RNR-' + Array.from({ length: 6 }, () => MEMBER_ALPHABET[randomInt(MEMBER_ALPHABET.length)]).join('');
