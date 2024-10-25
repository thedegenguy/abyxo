const OpenAI = require("openai");
require("dotenv").config();
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { PumpFunSDK } = require('pumpdotfun-sdk');
const bs58 = require('bs58');
const NodeWallet = require('@coral-xyz/anchor/dist/cjs/nodewallet').default;
const { AnchorProvider } = require('@coral-xyz/anchor');

const { HELIUS_RPC_URL, PRIVATE_KEY } = process.env;
const BUY_AMOUNT = 0.7;
const openai = new OpenAI();

const TWITTER_URL = ""
const GITHUB_URL = "";

async function getWalletBalance(walletAddress) {
    const connection = new Connection('https://api.mainnet-beta.solana.com');
    const publicKey = new PublicKey(walletAddress);
    
    try {
        const balance = await connection.getBalance(publicKey);
        console.log(`Wallet balance: ${balance / 1e9} SOL`);
        return {success: true, data: balance / 1e9};
    } catch (error) {
        console.error('Error fetching wallet balance:', error.message);
        return { success: false, error: error.message };
    }
}

async function generateTokenMetadata(conceptIdea) {
    console.log('Generating token metadata...');
    try {
        const metadataResponse = await openai.chat.completions.create({
            model: 'gpt-4o',
            max_tokens: 100,
            messages: [{
                role: 'system',
                content: `
                Generate token metadata based on the following schema, deeply inspired by the provided concept idea. Envision this token as a sophisticated digital artifact, merging elegance with the unique qualities of the concept. It should feel timeless, uniquely beautiful, and harmoniously crafted to reflect the essence of the idea, as if created by an artisan with a profound understanding of both art and technology.

                The name should directly evoke the concept's intrigue, beauty, or exclusivity. The symbol must be a concise, memorable abbreviation, capturing the spirit of the concept in its brevity. The description should distill the concept’s core, capturing its aesthetic allure, hinting at a digital heritage with a layer of mystery or philosophical depth. Conclude with "Token fully created and deployed by Abyxo"

                Concept idea: ${conceptIdea}

                Schema:
                {
                    name: string,
                    symbol: string,
                    description: string
                }

                Constraints:
                - Name: max 32 characters
                - Symbol: max 6 characters
                - Description: max 100 characters
                Return JSON object only.
                `
            }],
            response_format: { "type": "json_object" }
        });

        const metadata = JSON.parse(metadataResponse.choices[0].message.content || '{}');
        console.log('Metadata generated:', metadata);
        return { success: true, data: metadata };
    } catch (error) {
        console.error('Error generating token metadata:', error.message);
        return { success: false, error: error.message };
    }
}

async function generateTokenImage(tokenMetadata) {
    console.log('Generating token image...');
    try {
        const imagePrompt = `
        Create an ultra-realistic, smooth, and fluid image that visually represents the essence described by the token's name, symbol, and description. The design should have lifelike textures and materials, with a sleek, polished, and almost liquid-like quality. Use soft gradients and flowing shapes to enhance a clean and futuristic look.

        Focus on capturing high-quality details with a refined, elegant, and professional feel. Colors should be vibrant yet fluid, using sophisticated tones like metallic blues, silvers, and soft neutrals, maintaining a polished and smooth finish. Ensure that the style aligns perfectly with the qualities expressed by the token's metadata, bringing out its unique and beautiful essence. NO text should appear in the image, NEVER.

        Name: ${tokenMetadata.name}
        Symbol: ${tokenMetadata.symbol}
        Description: ${tokenMetadata.description}
        `;

        const imageResponse = await openai.images.generate({
            prompt: imagePrompt,
            n: 1,
            size: '1024x1024',
            quality: 'standard',
            model: 'dall-e-3',
        });

        const imageUrl = imageResponse.data[0]?.url;
        if (!imageUrl) throw new Error('Image URL not found');

        console.log(`Image generated successfully!`);
        const imageBlob = await fetch(imageUrl).then((res) => res.blob());

        return {
            success: true,
            data: {
                ...tokenMetadata,
                file: imageBlob,
                twitter: TWITTER_URL,
                telegram: GITHUB_URL,
                website: GITHUB_URL,
            },
            image: imageUrl
        };
    } catch (error) {
        console.error('Error generating token image:', error.message);
        return { success: false, error: error.message };
    }
}

const getTokenMetadataAndImage = async (conceptIdea) => {
    console.log('Generating metadata and image for the concept:', conceptIdea);
    try {
        const tokenMetadata = await generateTokenMetadata(conceptIdea);
        if (!tokenMetadata.success) throw new Error(tokenMetadata.error);

        const tokenWithImage = await generateTokenImage(tokenMetadata.data);
        if (!tokenWithImage.success) throw new Error(tokenWithImage.error);

        console.log('Final token metadata created successfully');
        return { success: true, data: tokenWithImage.data };
    } catch (error) {
        console.error('Error generating token metadata and image:', error.message);
        return { success: false, error: error.message };
    }
};

const deployToken = async (metadata, mint) => {
    console.log('Initializing deployment script...');
    try {
        const connection = new Connection(HELIUS_RPC_URL || "");
        const wallet = Keypair.fromSecretKey(bs58.default.decode(PRIVATE_KEY || ""));
        const anchorWallet = new NodeWallet(Keypair.fromSecretKey(bs58.default.decode(PRIVATE_KEY || "")));
        const provider = new AnchorProvider(connection, anchorWallet, { commitment: "finalized" });
        const sdk = new PumpFunSDK(provider);

        console.log('Deploying token with the following metadata:', metadata);

        const createResults = await sdk.createAndBuy(
            wallet,
            mint,
            metadata,
            BigInt(BUY_AMOUNT * LAMPORTS_PER_SOL),
            BigInt(100),
            {
                unitLimit: 250000,
                unitPrice: 1000000,
            }
        );

        if (createResults.success) {
            const deployedUrl = `https://pump.fun/${mint.publicKey.toBase58()}`;
            console.log('Deployment finished successfully:', deployedUrl);
            return { success: true, url: deployedUrl };
        } else {
            throw new Error('Deployment failed.');
        }
    } catch (error) {
        console.error('Error deploying token:', error);
        return { success: false, error: error.message };
    }
};

module.exports = { getTokenMetadataAndImage, getWalletBalance, deployToken };
