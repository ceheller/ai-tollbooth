import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { GoogleGenAI } from '@google/genai';

const app = express();
app.use(express.json());

// Initialize the environment
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const LNBITS_API_KEY = process.env.LNBITS_API_KEY;
const LNBITS_URL = 'https://legend.lnbits.com/api/v1';

app.get('/api/scrape', async (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'A target URL parameter is required.' });
  }

  const authHeader = req.headers.authorization;

  // Step 1: The Paywall. If the machine has not paid, hit it with a 402.
  if (!authHeader || !authHeader.startsWith('L402 ')) {
    try {
      const invoiceReq = await axios.post(`${LNBITS_URL}/payments`, {
        out: false,
        amount: 50, // The price: 50 Satoshis
        memo: `Data extraction requested for ${targetUrl}`
      }, {
        headers: { 'X-Api-Key': LNBITS_API_KEY }
      });

      const { payment_hash, payment_request } = invoiceReq.data;
      
      res.set('WWW-Authenticate', `L402 token="${payment_hash}", invoice="${payment_request}"`);
      return res.status(402).json({ 
        error: 'Payment Required to access this compute.', 
        invoice: payment_request 
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to negotiate with the Lightning Network.' });
    }
  }

  // Step 2: The Verification. The machine claims to have paid. We verify with the node.
  try {
    const tokenParts = authHeader.replace('L402 ', '').split(':');
    const paymentHash = tokenParts[0].trim();
    
    const verifyReq = await axios.get(`${LNBITS_URL}/payments/${paymentHash}`, {
      headers: { 'X-Api-Key': LNBITS_API_KEY }
    });

    if (!verifyReq.data.paid) {
      return res.status(402).json({ error: 'Nice try. The invoice is still unpaid.' });
    }

    // Step 3: The Execution. The Satoshis are secured. We extract the data.
    const { data: htmlData } = await axios.get(targetUrl);
    const $ = cheerio.load(htmlData);
    
    // Strip the noise, keep the text, cap it to prevent massive overloads
    const rawText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 10000);

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `You are an autonomous data parser. Extract the core informational data from the following raw website text into a clean, structured JSON format. Disregard navigation menus and advertisements: ${rawText}`
    });

    // Deliver the payload
    return res.status(200).json({ 
        success: true, 
        data: response.text 
    });

  } catch (error) {
    return res.status(500).json({ error: 'Extraction failed. The Satoshis remain yours, but the data is lost.' });
  }
});

export default app;
