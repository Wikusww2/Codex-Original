import OpenAI from 'openai';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from the project's .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  try {
    console.log("Fetching available models for your API key...");
    const list = await openai.models.list();

    console.log("----------------------------------------");
    console.log("Available models:");
    for (const model of list.data) {
      console.log(model.id);
    }
    console.log("----------------------------------------");
    console.log("\nPlease look for a model with 'search' or 'o' in the name, and update the 'webModel' property in your ~/.codex/config.json file with one of these models.");

  } catch (error) {
    console.error("Error fetching models:", error.message);
    console.error("Please ensure your OPENAI_API_KEY is set correctly in the .env file in the codex-cli directory.");
  }
}

main();
