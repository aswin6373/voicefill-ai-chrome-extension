const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const VISION_MODEL = 'llama-3.2-11b-vision-preview';
const TEXT_MODEL = 'llama-3.3-70b-versatile';

export interface FormField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'email';
}

async function groqChat(
  messages: any[],
  model: string,
  jsonMode: boolean = false
): Promise<string> {
  const body: any = {
    model,
    messages,
    temperature: 0.3,
    max_tokens: 4096,
  };

  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Groq API error:', response.status, errorText);
    throw new Error(`Groq API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

export async function analyzeFormStructure(imageUri: string): Promise<FormField[]> {
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: imageUri
          }
        },
        {
          type: "text",
          text: `Analyze this form image carefully. Identify ALL logical input fields visible in the form.

Return a JSON object with a "fields" key containing an array of objects. Each object must have:
- "id": a unique snake_case identifier (e.g., "full_name", "phone_number", "date_of_birth")
- "label": a human-readable label exactly as shown on the form
- "type": one of "text", "number", "date", or "email" — choose the best match for the field content

Be thorough — don't miss any fields. Include checkboxes as text fields with expected values like "yes/no".

Example response:
{"fields": [{"id": "full_name", "label": "Full Name", "type": "text"}, {"id": "email_address", "label": "Email Address", "type": "email"}]}`
        }
      ]
    }
  ];

  try {
    // Vision models may not support JSON mode well, so we disable it and parse manually
    const result = await groqChat(messages, VISION_MODEL, false);
    console.log("Raw Groq vision response:", result);
    
    // Try to extract JSON from the response (model may wrap it in markdown code blocks)
    let jsonStr = result;
    
    // Remove markdown code block wrappers if present
    const codeBlockMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }
    
    const parsed = JSON.parse(jsonStr);
    
    // Handle various response formats
    if (Array.isArray(parsed)) return parsed;
    if (parsed.fields && Array.isArray(parsed.fields)) return parsed.fields;
    // Check for any key that contains an array
    for (const key of Object.keys(parsed)) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    console.error("Unexpected response format:", parsed);
    return [];
  } catch (error) {
    console.error("Failed to analyze form structure:", error);
    return [];
  }
}


export async function getConversationTurn(
  userInput: string,
  fields: FormField[],
  currentValues: Record<string, any>
): Promise<{ extracted: Record<string, any>, reply: string, isComplete: boolean, clarifications: string[] }> {
  const fieldList = fields.map(f => `- ${f.id}: ${f.label} (${f.type})`).join('\n');
  const emptyFields = fields.filter(f => !currentValues[f.id]);

  const messages = [
    {
      role: "system",
      content: `You are "VoiceFill", a brilliant, empathetic, and meticulous form-filling AI assistant.
You are having a voice conversation with a human in real-time.
You MUST always respond with valid JSON in this exact format:
{
  "extracted": {},
  "reply": "your response",
  "isComplete": false,
  "clarifications": []
}`
    },
    {
      role: "user",
      content: `CONTEXT:
1. Form Fields (Strict list of IDs and what they mean):
${fieldList}

2. Already filled fields:
${JSON.stringify(currentValues)}

3. Still empty fields:
${emptyFields.map(f => `- ${f.id}: ${f.label}`).join('\n')}

USER'S LATEST SPOKEN INPUT (from speech-to-text, may contain errors): "${userInput}"

YOUR MISSIONS:
1. SMART EXTRACTION: The input comes from speech-to-text which is often inaccurate. You MUST:
   - Intelligently interpret what the user likely meant, even if words are misspelled or garbled.
   - For names: capitalize properly (e.g., "aswin" → "Aswin", "john doe" → "John Doe").
   - For emails: fix common speech-to-text errors (e.g., "at" → "@", "dot" → ".", "gmail dot com" → "gmail.com").
   - For phone numbers: extract digits even if spoken as words ("nine eight seven" → "987").
   - For dates: convert spoken dates to proper format ("January 15th 2000" → "2000-01-15").
   - USE THE EXACT SAME field IDs provided in the list above.
   
2. CONFIRMATION & CLARIFICATION: After extracting data:
   - ALWAYS read back what you extracted so the user can verify.
   - If something sounds ambiguous, flag it in "clarifications" and ask.
   - If the user says "no" or corrects something, update the value accordingly.
   
3. GUIDE THE CONVERSATION:
   - After confirming, ask for the NEXT most important empty field.
   - Be conversational, warm, and concise.
   - Ask for ONE field at a time.
   
4. COMPLETION: If all fields are filled, say "Perfect! I have all the details filled in."

IMPORTANT RULES:
- "extracted" must ONLY contain field IDs from the provided list.
- "reply" should be natural, concise, and always confirm what was heard.
- Keep reply under 3 sentences for better TTS experience.
- If the user just says "start" or "hello", don't extract anything — just greet them and ask for the first empty field.

Respond with ONLY valid JSON, no markdown, no code blocks.`
    }
  ];

  try {
    const result = await groqChat(messages, TEXT_MODEL, true);
    const parsed = JSON.parse(result);
    return {
      extracted: parsed.extracted || {},
      reply: parsed.reply || "I didn't quite catch that. Could you say it again?",
      isComplete: parsed.isComplete || false,
      clarifications: parsed.clarifications || []
    };
  } catch (error) {
    console.error("Groq conversation error:", error);
    return {
      extracted: {},
      reply: "I missed that. Could you say it again clearly?",
      isComplete: false,
      clarifications: []
    };
  }
}
