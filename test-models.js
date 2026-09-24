import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function listModels() {
  try {
    const models = await ai.models.list();
    console.log('📋 Verfügbare Modelle:');
    for await (const model of models) {
      if (model.name && model.name.toLowerCase().includes('live')) {
        console.log('  →', model.name);
      }
    }
  } catch (error) {
    console.error('❌ Fehler:', error.message);
  }
}

listModels();
