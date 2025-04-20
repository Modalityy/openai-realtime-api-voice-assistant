import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';
import instructions from './instructions.js';
import twilio from 'twilio';

const { validateRequest } = twilio;

// Load env
dotenv.config();

const {
    OPENAI_API_KEY,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    PORT,
    WEBHOOK_URL,
} = process.env;

const sessions = new Map();

const SYSTEM_MESSAGE = instructions;
const VOICE = 'alloy';

// Sanity check
if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error('Missing env vars');
    process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// --- Twilio Signature Validation ---
const validateTwilioSignature = (request) => {
    const signature = request.headers['x-twilio-signature'];
    const url = `${request.protocol}://${request.hostname}${request.raw.url}`;
    const params = request.method === 'POST' ? request.body : request.query;

    return validateRequest(TWILIO_AUTH_TOKEN, signature, url, params);
};

// --- Root Route ---
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// --- Incoming Call Route ---
fastify.all('/incoming-call', async (request, reply) => {
    console.log('Incoming call...');

    if (!validateTwilioSignature(request)) {
        reply.code(403).send({ error: 'Invalid Twilio signature' });
        return;
    }

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Say>
                Welcome to Lao Niang TCM. This call may be recorded for training purposes. Please choose if you want the call to be in English or Chinese
            </Say>
            <Connect>
                <Stream url="wss://${request.headers.host}/media-stream" />
            </Connect>
        </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// --- WebSocket Route ---
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        const sessionId =
            req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
        let session = sessions.get(sessionId) || {
            transcript: '',
            streamSid: null,
        };
        sessions.set(sessionId, session);

        const openAiWs = new WebSocket(
            'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'OpenAI-Beta': 'realtime=v1',
                },
            }
        );

        openAiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime API');
            setTimeout(() => {
                openAiWs.send(
                    JSON.stringify({
                        type: 'session.update',
                        session: {
                            turn_detection: { type: 'server_vad' },
                            input_audio_format: 'g711_ulaw',
                            output_audio_format: 'g711_ulaw',
                            voice: VOICE,
                            instructions: SYSTEM_MESSAGE,
                            modalities: ['text', 'audio'],
                            temperature: 0.8,
                            input_audio_transcription: {
                                model: 'whisper-1',
                            },
                        },
                    })
                );
            }, 250);
        });

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (
                    response.type ===
                    'conversation.item.input_audio_transcription.completed'
                ) {
                    const userMessage = response.transcript.trim();
                    session.transcript += `User: ${userMessage}\n`;
                    console.log(`User (${sessionId}): ${userMessage}`);
                }

                if (response.type === 'response.done') {
                    const agentMessage =
                        response.response.output[0]?.content?.find(
                            (c) => c.transcript
                        )?.transcript || 'Agent message not found';
                    session.transcript += `Agent: ${agentMessage}\n`;
                    console.log(`Agent (${sessionId}): ${agentMessage}`);
                }

                if (
                    response.type === 'response.audio.delta' &&
                    response.delta
                ) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: session.streamSid,
                        media: {
                            payload: Buffer.from(
                                response.delta,
                                'base64'
                            ).toString('base64'),
                        },
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error);
            }
        });

        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (
                    data.event === 'media' &&
                    openAiWs.readyState === WebSocket.OPEN
                ) {
                    openAiWs.send(
                        JSON.stringify({
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload,
                        })
                    );
                }
                if (data.event === 'start') {
                    session.streamSid = data.start.streamSid;
                    console.log('Incoming stream started', session.streamSid);
                }
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });

        connection.on('close', async () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log(`Client disconnected (${sessionId})`);
            console.log('Full Transcript:', session.transcript);
            await processTranscriptAndSend(session.transcript, sessionId);
            sessions.delete(sessionId);
        });

        openAiWs.on('close', () => {
            console.log('Disconnected from OpenAI');
        });

        openAiWs.on('error', (error) => {
            console.error('OpenAI WebSocket error:', error);
        });
    });
});

// --- Start Server ---
fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});

// --- Helper: Process Transcript ---
async function processTranscriptAndSend(transcript, sessionId) {
    try {
        const result = await makeChatGPTCompletion(transcript);
        if (result?.choices?.[0]?.message?.content) {
            const parsed = JSON.parse(result.choices[0].message.content);
            await sendToWebhook(parsed);
            console.log('Sent to webhook:', parsed);
        } else {
            console.error('Unexpected ChatGPT response structure');
        }
    } catch (error) {
        console.error('Error in processTranscriptAndSend:', error);
    }
}

// --- Helper: OpenAI Chat Completion ---
async function makeChatGPTCompletion(transcript) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'gpt-4o-2024-08-06',
            messages: [
                {
                    role: 'system',
                    content:
                        'Extract customer details: name, availability, and any special notes from the transcript.',
                },
                { role: 'user', content: transcript },
            ],
        }),
    });

    return await response.json();
}

// --- Helper: Send to ActivePieces Webhook (later use) ---
async function sendToWebhook(payload) {
    try {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        console.log('Webhook status:', response.status);
    } catch (error) {
        console.error('Error sending webhook:', error);
    }
}
