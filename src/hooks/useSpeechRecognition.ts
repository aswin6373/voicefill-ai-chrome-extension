import { useState, useEffect, useRef, useCallback } from 'react';

interface UseSpeechRecognitionProps {
  onResult: (text: string) => void;
  onEnd?: (finalTranscript: string) => void;
}

export function useSpeechRecognition({ onResult, onEnd }: UseSpeechRecognitionProps) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const recognitionRef = useRef<any>(null);
  const transcriptRef = useRef('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isStoppingRef = useRef(false);

  const onResultRef = useRef(onResult);
  const onEndRef = useRef(onEnd);

  useEffect(() => {
    onResultRef.current = onResult;
    onEndRef.current = onEnd;
  });

  const createRecognition = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("Speech recognition not supported in this browser.");
      return null;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 3;

    recognition.onresult = (event: any) => {
      let finalText = '';
      let interimText = '';

      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          // Use the highest-confidence alternative
          let bestAlt = result[0];
          for (let j = 1; j < result.length; j++) {
            if (result[j].confidence > bestAlt.confidence) {
              bestAlt = result[j];
            }
          }
          finalText += bestAlt.transcript;
        } else {
          interimText += result[0].transcript;
        }
      }

      const fullText = (finalText + interimText).trim();
      transcriptRef.current = fullText;
      setTranscript(fullText);
      onResultRef.current(fullText);

      // Reset silence timeout - give user 3 seconds of silence before auto-stopping
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        if (fullText.trim() && recognitionRef.current) {
          isStoppingRef.current = true;
          recognitionRef.current.stop();
        }
      }, 3000);
    };

    recognition.onend = () => {
      setIsListening(false);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      
      const finalTranscript = transcriptRef.current;
      if (onEndRef.current) {
        onEndRef.current(finalTranscript);
      }
      isStoppingRef.current = false;
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error:", event.error);
      if (event.error === 'no-speech') {
        // Restart if no speech detected - don't treat as fatal
        return;
      }
      setIsListening(false);
      isStoppingRef.current = false;
    };

    return recognition;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch {}
      }
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const startListening = useCallback(() => {
    if (isListening) return;
    
    // Create a fresh instance each time to avoid "already started" errors
    const recognition = createRecognition();
    if (!recognition) return;
    
    recognitionRef.current = recognition;
    transcriptRef.current = '';
    setTranscript('');
    
    try {
      recognition.start();
      setIsListening(true);
    } catch (err) {
      console.error("Speech recognition start failed:", err);
    }
  }, [isListening, createRecognition]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current && isListening) {
      try {
        isStoppingRef.current = true;
        recognitionRef.current.stop();
      } catch (err) {
        console.error("Speech recognition stop failed:", err);
      }
      setIsListening(false);
    }
  }, [isListening]);

  const getCurrentTranscript = useCallback(() => {
    return transcriptRef.current;
  }, []);

  return { isListening, transcript, startListening, stopListening, getCurrentTranscript };
}
