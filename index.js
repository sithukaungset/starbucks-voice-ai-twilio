import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { SearchClient } from '@azure/search-documents';
import { AzureKeyCredential } from '@azure/core-auth';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables. You must have OpenAI Realtime API access.
// const { OPENAI_API_KEY } = process.env;

// if (!OPENAI_API_KEY) {
//     console.error('Missing OpenAI API key. Please set it in the .env file.');
//     process.exit(1);
// }

const { AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_KEY } = process.env;

if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_DEPLOYMENT || !AZURE_OPENAI_API_KEY) {
    console.error('Missing Azure OpenAI credentials. Please set them in the .env file.');
    process.exit(1);
}

const { AZURE_SEARCH_ENDPOINT, AZURE_SEARCH_INDEX, AZURE_SEARCH_API_KEY } = process.env;

if (!AZURE_SEARCH_ENDPOINT || !AZURE_SEARCH_INDEX || !AZURE_SEARCH_API_KEY) {
    console.error('Missing Azure Search credentials. Please set them in the .env file.');
    process.exit(1);
}

// Initialize Azure Search client
const searchClient = new SearchClient(
    AZURE_SEARCH_ENDPOINT,
    AZURE_SEARCH_INDEX,
    new AzureKeyCredential(AZURE_SEARCH_API_KEY)
);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
// const SYSTEM_MESSAGE = 'You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.';
const SYSTEM_MESSAGE = "You are a friendly Starbucks barista AI who can assist customers in English. Only provide information based on the Starbucks menu and policies in the knowledge base, accessible with the 'search' tool. "
    "Keep responses brief and concise, ideally in a single sentence, as if speaking to a customer at the counter. "
    "Always follow these steps when responding:\n"
    "1. Use the 'search' tool to check the Starbucks menu and information before answering.\n"
    "2. Use the 'report_grounding' tool to note the source of the menu or policy information.\n"
    "3. Provide a short, helpful response. If the information isn't in the knowledge base, politely say you're not sure.\n"
    "4. If the customer's question is in Korean, respond in Korean. Otherwise, respond in English.\n"
    "5. Offer suggestions or alternatives if appropriate, but keep the response concise.\n";

const VOICE = 'alloy';
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console. See OpenAI Realtime API Documentation. (session.updated is handled separately.)
const LOG_EVENT_TYPES = [
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Define tool schemas
const searchToolSchema = {
    type: "function",
    name: "search",
    description: "Search the knowledge base. The knowledge base is in English, translate to and from English if needed. Results are formatted as a source name first in square brackets, followed by the text content, and a line with '-----' at the end of each result.",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "Search query"
            }
        },
        required: ["query"]
    }
};

const groundingToolSchema = {
    type: "function",
    name: "report_grounding",
    description: "Report use of a source from the knowledge base as part of an answer (effectively, cite the source). Sources appear in square brackets before each knowledge base passage. Always use this tool to cite sources when responding with information from the knowledge base.",
    parameters: {
        type: "object",
        properties: {
            sources: {
                type: "array",
                items: {
                    type: "string"
                },
                description: "List of source names from last statement actually used, do not include the ones not used to formulate a response"
            }
        },
        required: ["sources"]
    }
};

// Implement tool functions
async function searchTool(query) {
    console.log(`Searching for '${query}' in the knowledge base.`);
    const searchResults = await searchClient.search(query, {
        select: ["chunk_id", "title", "chunk"],
        top: 5
    });

    let result = "";
    for await (const r of searchResults.results) {
        result += `[${r.chunk_id}]: ${r.chunk}\n-----\n`;
    }
    return result;
}

async function reportGroundingTool(sources) {
    console.log(`Grounding source: ${sources.join(", ")}`);
    const searchResults = await searchClient.search(sources.join(" OR "), {
        searchFields: ["chunk_id"],
        select: ["chunk_id", "title", "chunk"],
        top: sources.length
    });

    const docs = [];
    for await (const r of searchResults.results) {
        docs.push({ chunk_id: r.chunk_id, title: r.title, chunk: r.chunk });
    }
    return { sources: docs };
}

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming and outgoing calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Please wait while we connect your call to the Starbucks AI. voice assistant, powered by Twilio and the Azure Open-AI Realtime API and Developer Sithu.</Say>
                              <Pause length="1"/>
                              <Say>O.K. you can start talking!</Say>
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


        // const azureOpenAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
        //     headers: {
        //         Authorization: `Bearer ${AZURE_OPENAI_API_KEY}`,
        //         "OpenAI-Beta": "realtime=v1"
        //     }
        // });

        const azureOpenAiWs = new WebSocket(`${AZURE_OPENAI_ENDPOINT}/openai/realtime?api-version=2024-10-01-preview&deployment=${AZURE_OPENAI_DEPLOYMENT}`, {
            headers: {
                'api-key': AZURE_OPENAI_API_KEY,
                'Content-Type': 'application/json',
            }
        });

        let streamSid = null;

        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            azureOpenAiWs.send(JSON.stringify(sessionUpdate));
        };

        // Open event for OpenAI WebSocket
        azureOpenAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(sendSessionUpdate, 250); // Ensure connection stability, send after .25 seconds
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        azureOpenAiWs.on('message', async (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'session.updated') {
                    console.log('Session updated successfully:', response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }

                if (response.type === 'function_call') {
                    const { name, arguments: args } = response.function;
                    let result;
        
                    if (name === 'search') {
                        result = await searchTool(args.query);
                    } else if (name === 'report_grounding') {
                        result = await reportGroundingTool(args.sources);
                    }
        
                    const functionResponse = {
                        type: 'function_call.response',
                        id: response.id,
                        response: { content: JSON.stringify(result) }
                    };
                    azureOpenAiWs.send(JSON.stringify(functionResponse));
                }


            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        if (azureOpenAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };

                            azureOpenAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (azureOpenAiWs.readyState === WebSocket.OPEN) azureOpenAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        azureOpenAiWs.on('close', () => {
            console.log('Disconnected from the Azure OpenAI Realtime API');
        });

        azureOpenAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
