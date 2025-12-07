import { createClient } from 'npm:@base44/sdk@0.8.4';

// Diese Funktion wird auf einem externen Server (z.B. Deno Deploy) ausgeführt
Deno.serve(async (req) => {
    // 1. Upgrade der Anfrage zu einer WebSocket-Verbindung
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expecting WebSocket connection.", { status: 400 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);

    // 2. WebSocket-Event-Handler mit separaten Deepgram-Verbindungen
    let deepgramWsInbound = null;
    let deepgramWsOutbound = null;
    let isDeepgramInboundOpen = false;
    let isDeepgramOutboundOpen = false;
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

                // Deepgram-Verbindung für INBOUND (Anrufer)
                deepgramWsInbound = new WebSocket(
                    `wss://api.deepgram.com/v1/listen?model=nova-3&language=de&punctuate=true&encoding=mulaw&sample_rate=8000&channels=1`,
                    ['token', deepgramApiKey]
                );

                deepgramWsInbound.onopen = () => {
                    console.log('[External WS] Deepgram INBOUND connected');
                    isDeepgramInboundOpen = true;
                };

                deepgramWsInbound.onmessage = async (msg) => {
                    const transcriptData = JSON.parse(msg.data);
                    
                    // Nur finale Transkripte verarbeiten
                    if (transcriptData.is_final && transcriptData.channel?.alternatives?.[0]?.transcript) {
                        const text = transcriptData.channel.alternatives[0].transcript.trim();
                        if (text.length > 0) {
                            console.log(`[Transcript INBOUND] Customer: ${text}`);
                            
                            conversationHistory.push({ speaker: 'customer', text });

                            // Fire-and-forget: Sende Transkript an Base44
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
                                    speaker: 'customer',
                                    conversationHistory: conversationHistory.slice(-10).map(h => `${h.speaker}: ${h.text}`).join("\n")
                                })
                            }).catch((e) => {
                                console.error('[External WS] Error sending inbound transcript to Base44:', e);
                            });
                        }
                    }
                };
                
                deepgramWsInbound.onerror = (error) => {
                    console.error('[External WS] Deepgram INBOUND error:', error);
                };
                
                deepgramWsInbound.onclose = (event) => {
                    console.log(`[External WS] Deepgram INBOUND closed. Code: ${event.code}, Reason: ${event.reason}`);
                    isDeepgramInboundOpen = false;
                };

                // Deepgram-Verbindung für OUTBOUND (Agent)
                deepgramWsOutbound = new WebSocket(
                    `wss://api.deepgram.com/v1/listen?model=nova-3&language=de&punctuate=true&encoding=mulaw&sample_rate=8000&channels=1`,
                    ['token', deepgramApiKey]
                );

                deepgramWsOutbound.onopen = () => {
                    console.log('[External WS] Deepgram OUTBOUND connected');
                    isDeepgramOutboundOpen = true;
                };

                deepgramWsOutbound.onmessage = async (msg) => {
                    const transcriptData = JSON.parse(msg.data);
                    
                    // Nur finale Transkripte verarbeiten
                    if (transcriptData.is_final && transcriptData.channel?.alternatives?.[0]?.transcript) {
                        const text = transcriptData.channel.alternatives[0].transcript.trim();
                        if (text.length > 0) {
                            console.log(`[Transcript OUTBOUND] Agent: ${text}`);
                            
                            conversationHistory.push({ speaker: 'agent', text });

                            // Fire-and-forget: Sende Transkript an Base44
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
                                    speaker: 'agent',
                                    conversationHistory: conversationHistory.slice(-10).map(h => `${h.speaker}: ${h.text}`).join("\n")
                                })
                            }).catch((e) => {
                                console.error('[External WS] Error sending outbound transcript to Base44:', e);
                            });
                        }
                    }
                };
                
                deepgramWsOutbound.onerror = (error) => {
                    console.error('[External WS] Deepgram OUTBOUND error:', error);
                };
                
                deepgramWsOutbound.onclose = (event) => {
                    console.log(`[External WS] Deepgram OUTBOUND closed. Code: ${event.code}, Reason: ${event.reason}`);
                    isDeepgramOutboundOpen = false;
                };

                break;
            }

            case 'media': {
                // Route audio packets to the correct Deepgram connection based on track
                const track = data.media.track;
                
                if (track === 'inbound') {
                    // Inbound track (Customer)
                    if (isDeepgramInboundOpen && deepgramWsInbound?.readyState === WebSocket.OPEN) {
                        const audioPayload = atob(data.media.payload);
                        const len = audioPayload.length;
                        const bytes = new Uint8Array(len);
                        for (let i = 0; i < len; i++) {
                            bytes[i] = audioPayload.charCodeAt(i);
                        }
                        deepgramWsInbound.send(bytes);
                    }
                } else if (track === 'outbound') {
                    // Outbound track (Agent)
                    if (isDeepgramOutboundOpen && deepgramWsOutbound?.readyState === WebSocket.OPEN) {
                        const audioPayload = atob(data.media.payload);
                        const len = audioPayload.length;
                        const bytes = new Uint8Array(len);
                        for (let i = 0; i < len; i++) {
                            bytes[i] = audioPayload.charCodeAt(i);
                        }
                        deepgramWsOutbound.send(bytes);
                    }
                }
                break;
            }

            case 'stop': {
                console.log('[External WS] Stream stopped');
                if (deepgramWsInbound) deepgramWsInbound.close();
                if (deepgramWsOutbound) deepgramWsOutbound.close();
                break;
            }
        }
    };

    socket.onclose = () => {
        console.log("[External WS] Twilio WS closed");
        if (deepgramWsInbound) deepgramWsInbound.close();
        if (deepgramWsOutbound) deepgramWsOutbound.close();
    };

    socket.onerror = (e) => {
        console.error("[External WS] Twilio WS Error:", e);
    };

    return response;
});
