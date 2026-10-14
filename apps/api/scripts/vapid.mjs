// Gera o par de chaves VAPID dos avisos no telemóvel. Guardar a privada só no servidor (variável de ambiente).
import webpush from 'web-push';
const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`);
