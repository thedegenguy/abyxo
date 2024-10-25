const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const OpenAI = require("openai");
const { Keypair } = require('@solana/web3.js');
require("dotenv").config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY  // Add API key here if necessary
});
const token = process.env.TELEGRAM_BOT_API;
const assistantId = process.env.ASSISTANT_ID;
const bot = new TelegramBot(token, { polling: true });
const THREADS_FILE = 'threads.json';
const DEV_WALLET = process.env.DEV_WALLET;

const { getTokenMetadataAndImage, getWalletBalance, deployToken } = require("./utils/functions.js");

console.log("Telegram bot is up and running, ready to receive messages.");

const pumpKeypairGen = async (userId) => {
    let keypair = new Keypair();
    let count = 0;

    while (keypair.publicKey.toBase58().slice(-4) !== 'pump' && count < 1_000_000) {
        keypair = new Keypair();
        count += 1;

        if (count % 20000 === 0) {
            await bot.sendMessage(userId, `Iteration count: ${count}/1000000`);
        }
    }

    return keypair;
}

function readThreads() {
    try {
        return JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8'));
    } catch (err) {
        console.error("Error reading threads.json:", err.message);
        return [];
    }
}

function writeThreads(threads) {
    try {
        fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2), 'utf8');
    } catch (err) {
        console.error("Error writing to threads.json:", err.message);
    }
}

async function getOrCreateThreadId(userId) {
    const threads = readThreads();
    let userThread = threads.find(thread => thread.userId === userId);

    if (!userThread) {
        try {
            const { id: newThreadId } = await openai.beta.threads.create();
            userThread = { userId, threadId: newThreadId };
            threads.push(userThread);
            writeThreads(threads);
        } catch (err) {
            console.error("Error creating a new thread ID:", err.message);
            throw err;
        }
    }

    return userThread.threadId;
}

bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    try {
        const threadId = await getOrCreateThreadId(userId);
        await bot.sendMessage(userId, `Welcome! How can I assist you today? Your thread ID is: ${threadId}`);
    } catch (err) {
        console.error("Error handling /start command:", err.message);
        await bot.sendMessage(userId, "An error occurred while starting the conversation.");
    }
});

bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const userMessage = msg.text;

    try {
        const threadId = await getOrCreateThreadId(userId);

        await openai.beta.threads.messages.create(threadId, {
            role: "user",
            content: userMessage
        });

        openai.beta.threads.runs.stream(threadId, { assistant_id: assistantId })
            .on('textCreated', () => bot.sendChatAction(userId, "typing"))
            .on('textDone', async (text) => {
                try {
                    await bot.sendMessage(userId, text.value);
                } catch (err) {
                    console.error("Error sending bot message:", err.message);
                }
            })
            .on("event", async (event) => {
                if (event?.event === 'thread.run.requires_action') {
                    const callId = event.data.required_action.submit_tool_outputs.tool_calls[0].id;

                    try {
                        await bot.sendMessage(userId, "Fetching SOL balance...");
                        const balanceResponse = await getWalletBalance(DEV_WALLET);

                        if (!balanceResponse.success || balanceResponse.data < 0.7) {
                            console.log("hello", balanceResponse)
                            const output = `Unfortunately, my wallet balance is only ${balanceResponse.data || 0} SOL, which is less than the required 0.7 SOL. I cannot create more tokens at this time.`;
                            await openai.beta.threads.runs.submitToolOutputsAndPoll(threadId, event.data.id, {
                                tool_outputs: [{ tool_call_id: callId, output }]
                            });
                            const { data: messages } = await openai.beta.threads.messages.list(threadId);
                            await bot.sendMessage(userId, messages[0].content[0].text.value);
                            return;
                        }

                        await bot.sendMessage(userId, "Generating metadata...");
                        const params = JSON.parse(event.data.required_action.submit_tool_outputs.tool_calls[0].function.arguments);
                        const { idea } = params;
                        const metadataResponse = await getTokenMetadataAndImage(idea);

                        if (!metadataResponse.success) {
                            const output = metadataResponse.error
                            await openai.beta.threads.runs.submitToolOutputsAndPoll(threadId, event.data.id, {
                                tool_outputs: [{ tool_call_id: callId, output }]
                            });
                            const { data: messages } = await openai.beta.threads.messages.list(threadId);
                            await bot.sendMessage(userId, messages[0].content[0].text.value);
                            throw new Error(metadataResponse.error);
                        }

                        const metadata = metadataResponse.data;
                        const metadataMessage = `
                            *Token Metadata Generated Successfully!*\nName: ${metadata.name}\nSymbol: ${metadata.symbol}\nDescription: ${metadata.description}
                        `;
                        await bot.sendMessage(userId, metadataMessage, { parse_mode: 'Markdown' });
                        await bot.sendPhoto(userId, metadataResponse?.image, { caption: `${metadata.name} (${metadata.symbol})` });

                        await bot.sendMessage(userId, "Generating mint address...");
                        const keypair = await pumpKeypairGen(userId);
                        await bot.sendMessage(userId, `Mint address successfully generated: ${keypair.publicKey}`);
                        await bot.sendMessage(userId, "Initializing deployment scripts...");
                        const deployResponse = await deployToken(metadata, keypair);

                        if (!deployResponse.success) {
                            const output = deployResponse.error
                            await openai.beta.threads.runs.submitToolOutputsAndPoll(threadId, event.data.id, {
                                tool_outputs: [{ tool_call_id: callId, output }]
                            });
                            const { data: messages } = await openai.beta.threads.messages.list(threadId);
                            await bot.sendMessage(userId, messages[0].content[0].text.value);
                            throw new Error(deployResponse.error);
                        }
                        bot.sendMessage(userId, deployResponse.url)
                        await openai.beta.threads.runs.submitToolOutputsAndPoll(threadId, event.data.id, {
                            tool_outputs: [{ tool_call_id: callId, output: `Deployment finished successfully: ${deployResponse.url}` }]
                        });

                        const { data: messages } = await openai.beta.threads.messages.list(threadId);
                        await bot.sendMessage(userId, messages[0].content[0].text.value);
                    } catch (err) {
                        console.error("Error during action handling:", err.message);
                        await bot.sendMessage(userId, "An error occurred while processing your request.");
                    }
                }
            });
    } catch (err) {
        console.error("Error processing user message:", err.message);
        if (err.message.includes("Can't add messages to") && err.message.includes("while a run is running")) {
            await bot.sendMessage(userId, "Please wait for the previous response before sending another message.");
        } else {
            await bot.sendMessage(userId, "An error occurred while processing your message.");
        }
    }
});
