import { createClient } from 'npm:@base44/sdk@0.8.4';

// Diese Funktion wird auf einem externen Server (z.B. Deno Deploy) ausgeführt
Deno.serve(async (req) => {
    // 1. Upgrade der Anfrage zu einer WebSocket-Verbindung
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expecting WebSocket connection.", { status: 400 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);

    // 2. WebSocket-Event-Handler
    let deepgramWs = null;
    let isDeepgramOpen = false;
    let conversationHistory = [];

    socket.onopen = () => {
        console.log("[External WS] Twilio WebSocket connected");
    };

    socket.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        switch (data.event) {
            case 'start': {
                console.log("[External WS] Stream started:", data.start);
                const { callSid, customParameters } = data.start;
                const { clientId, generate_agent_tips_api_key, base44_app_id } = customParameters;

                if (!generate_agent_tips_api_key || !base44_app_id) {
                    console.error("[External WS] Base44 App ID or generateAgentTips API key missing in parameters.");
                    return;
                }

                const deepgramApiKey = Deno.env.get('DEEPGRAM_API_KEY');
                if (!deepgramApiKey) {
                    console.error('[External WS] DEEPGRAM_API_KEY missing');
                    return;
                }

                deepgramWs = new WebSocket(
                    `wss://api.deepgram.com/v1/listen?model=nova-3&language=de&diarize=true&punctuate=true&encoding=mulaw&sample_rate=8000&channels=2&multichannel=true`,
                    ['token', deepgramApiKey]
                );

                deepgramWs.onopen = () => {
                    console.log('[External WS] Deepgram connected');
                    isDeepgramOpen = true;
                };

                deepgramWs.onmessage = async (msg) => {
                    const transcriptData = JSON.parse(msg.data);
                    
                    // Debug: Logge alle Deepgram-Nachrichten mit Details
                    const transcript = transcriptData.channel?.alternatives?.[0]?.transcript || '';
                    console.log('[Deepgram Debug] type:', transcriptData.type, 'is_final:', transcriptData.is_final, 'text:', transcript ? `"${transcript}"` : '(empty)');
                    
                    // Nur finale Transkripte verarbeiten
                    if (transcriptData.is_final && transcriptData.channel?.alternatives?.[0]?.transcript) {
                        const text = transcriptData.channel.alternatives[0].transcript.trim();
                        if (text.length > 0) {
                            const speaker = transcriptData.channel.alternatives[0].words?.[0]?.speaker || 0;
                            console.log(`[Transcript] Speaker ${speaker}: ${text}`);
                            
                        conversationHistory.push({ speaker: speaker === 0 ? 'agent' : 'customer', text });

                        // Fire-and-forget: Sende Transkript an Base44 ohne auf Response zu warten
                        const base44FunctionUrl = `https://power-dialer-pro-bc2ca247.base44.app/api/apps/${base44_app_id}/functions/generateAgentTips`;

                        fetch(base44FunctionUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'api_key': generate_agent_tips_api_key
                            },
                            body: JSON.stringify({
                                transcript: text,
                                callSid: callSid,
                                clientId: clientId,
                                speaker: speaker,
                                conversationHistory: conversationHistory.slice(-5).map(h => `${h.speaker}: ${h.text}`).join("\n")
                            })
                        }).catch((e) => {
                            console.error('[External WS] Error sending transcript to Base44:', e);
                        });
                        }
                    }
                };
                
                deepgramWs.onerror = (error) => {
                    console.error('[External WS] Deepgram error:', error);
                };
                
                deepgramWs.onclose = (event) => {
                    console.log(`[External WS] Deepgram closed. Code: ${event.code}, Reason: ${event.reason}`);
                    isDeepgramOpen = false;
                };
                break;
            }

            case 'media': {
                // Debug: Zähle Audio-Pakete
                if (!globalThis.audioPacketCount) globalThis.audioPacketCount = 0;
                globalThis.audioPacketCount++;
                
                if (globalThis.audioPacketCount % 100 === 0) {
                    console.log(`[Audio Debug] Received ${globalThis.audioPacketCount} audio packets, Deepgram open: ${isDeepgramOpen}, WS state: ${deepgramWs?.readyState}`);
                }
                
                if (isDeepgramOpen && deepgramWs?.readyState === WebSocket.OPEN) {
                    const audioPayload = atob(data.media.payload);
                    const len = audioPayload.length;
                    const bytes = new Uint8Array(len);
                    for (let i = 0; i < len; i++) {
                        bytes[i] = audioPayload.charCodeAt(i);
                    }
                    deepgramWs.send(bytes);
                } else {
                    console.log(`[Audio Debug] Cannot send audio - Deepgram open: ${isDeepgramOpen}, WS state: ${deepgramWs?.readyState}`);
                }
                break;
            }

            case 'stop': {
                console.log('[External WS] Stream stopped');
                if (deepgramWs) deepgramWs.close();
                break;
            }
        }
    };

    socket.onclose = () => {
        console.log("[External WS] Twilio WS closed");
        if (deepgramWs) deepgramWs.close();
    };

    socket.onerror = (e) => {
        console.error("[External WS] Twilio WS Error:", e);
    };

    return response;
});
