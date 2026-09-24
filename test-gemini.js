import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: 'Sag Hallo auf Deutsch.',
    });
    console.log('✅ Antwort:', response.text);
  } catch (error) {
    console.error('❌ Fehler:', error.message);
  }
}

test();
