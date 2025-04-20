import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';
import instructions from './instructions';
import { validateRequest } from 'twilio'; // Twilio SDK for signature validation

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key and Twilio credentials from environment variables
const {
    OPENAI_API_KEY,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    BASIC_AUTH_USERNAME,
    BASIC_AUTH_PASSWORD,
    PORT,
    WEBHOOK_URL,
} = process.env;

// Session management
const sessions = new Map();

// Constants
const SYSTEM_MESSAGE = instructions;
const VOICE = 'alloy';

// Ensure environment variables are loaded
if (
    !OPENAI_API_KEY ||
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    !BASIC_AUTH_USERNAME ||
    !BASIC_AUTH_PASSWORD
) {
    console.error(
        'Missing necessary environment variables. Please set them in the .env file.'
    );
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Basic Authentication middleware
fastify.addHook('onRequest', (request, reply, done) => {
    const auth = request.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
        reply
            .code(401)
            .send({ error: 'Authorization header missing or malformed' });
        return;
    }
    const base64Credentials = auth.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString(
        'utf8'
    );
    const [username, password] = credentials.split(':');

    if (username !== BASIC_AUTH_USERNAME || password !== BASIC_AUTH_PASSWORD) {
        reply.code(401).send({ error: 'Invalid username or password' });
        return;
    }
    done();
});

// Function to validate Twilio signature
const validateTwilioSignature = (req) => {
    const signature = req.headers['x-twilio-signature'];
    const url = req.raw.url;
    const params = req.query; // Get the parameters sent by Twilio

    // Validate the signature using the Twilio SDK
    const isValid = validateRequest(TWILIO_AUTH_TOKEN, signature, url, params);

    return isValid;
};

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming and outgoing calls
fastify.all('/incoming-call', async (request, reply) => {
    console.log('Incoming call');

    // Validate Twilio signature
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

// WebSocket route for media-stream
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

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
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

        // Listen for messages from the OpenAI WebSocket
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
                            (content) => content.transcript
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

        // Handle incoming messages from Twilio
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
                    console.log(
                        'Incoming stream has started',
                        session.streamSid
                    );
                }
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });

        // Handle connection close and log transcript
        connection.on('close', async () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log(`Client disconnected (${sessionId}).`);
            console.log('Full Transcript:', session.transcript);
            await processTranscriptAndSend(session.transcript, sessionId);
            sessions.delete(sessionId);
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Start server
fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});

// Function to process and send customer details
async function processTranscriptAndSend(transcript, sessionId) {
    try {
        const result = await makeChatGPTCompletion(transcript);
        console.log(
            'Raw result from ChatGPT:',
            JSON.stringify(result, null, 2)
        );
        if (
            result.choices &&
            result.choices[0] &&
            result.choices[0].message.content
        ) {
            const parsedContent = JSON.parse(result.choices[0].message.content);
            console.log(
                'Parsed content:',
                JSON.stringify(parsedContent, null, 2)
            );
            if (parsedContent) {
                await sendToWebhook(parsedContent);
                console.log(
                    'Extracted and sent customer details:',
                    parsedContent
                );
            }
        } else {
            console.error('Unexpected response structure from ChatGPT API');
        }
    } catch (error) {
        console.error('Error in processTranscriptAndSend:', error);
    }
}

// Function to make ChatGPT API call for processing the transcript
async function makeChatGPTCompletion(transcript) {
    try {
        const response = await fetch(
            'https://api.openai.com/v1/chat/completions',
            {
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
            }
        );

        const data = await response.json();
        console.log('ChatGPT API response:', data);
        return data;
    } catch (error) {
        console.error('Error making ChatGPT API call:', error);
    }
}

// Function to send data to Make.com webhook
async function sendToWebhook(payload) {
    try {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        console.log('Webhook response:', response.status);
    } catch (error) {
        console.error('Error sending data to webhook:', error);
    }
}
