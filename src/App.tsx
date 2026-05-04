/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Mic, MicOff, Send, FileText, CheckCircle2, RotateCcw, Upload, Loader2, Sparkles, Volume2, MessageSquare, Download, AlertCircle, PenLine } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { analyzeFormStructure, getConversationTurn, FormField } from './lib/gemini';

export default function App() {
  const [fields, setFields] = useState<FormField[]>([]);
  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string, type: 'info' | 'success' | 'error' | 'ai' | 'warning' } | null>(null);
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [aiMessage, setAiMessage] = useState<string>("Upload a form to get started.");
  const [clarifications, setClarifications] = useState<string[]>([]);
  const [editingField, setEditingField] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);

  const speak = (text: string, onEnd?: () => void) => {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    if (onEnd) {
      utterance.onend = () => onEnd();
    }
    window.speechSynthesis.speak(utterance);
  };

  const showFeedback = (text: string, type: 'info' | 'success' | 'error' | 'ai' | 'warning' = 'info') => {
    setFeedback({ text, type });
    if (type !== 'ai') {
      const timer = setTimeout(() => setFeedback(null), 4000);
      return () => clearTimeout(timer);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsAnalyzing(true);
    setAiMessage("Analyzing your form image... one moment.");
    showFeedback("Extracting fields...");

    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target?.result as string;
      setUploadedImage(base64);
      try {
        const extractedFields = await analyzeFormStructure(base64);
        setFields(extractedFields);
        setFormValues({});
        setClarifications([]);
        const msg = `I've found ${extractedFields.length} fields in your form. Tap the microphone and start telling me your details, or just say "Start"!`;
        setAiMessage(msg);
        speak(msg);
        showFeedback("Ready to fill!", "success");
      } catch (err) {
        setAiMessage("I couldn't read that form. Could you try a clearer photo?");
        showFeedback("Analysis failed.", "error");
      } finally {
        setIsAnalyzing(false);
      }
    };
    reader.readAsDataURL(file);
    if (event.target) event.target.value = '';
  };

  const processConversation = async (text: string) => {
    if (!text.trim() || processingRef.current) {
      return;
    }
    
    processingRef.current = true;
    setIsProcessing(true);
    showFeedback("Processing your input...", "ai");
    
    try {
      const result = await getConversationTurn(text, fields, formValues);
      
      const newValues = { ...formValues, ...result.extracted };
      setFormValues(newValues);
      setAiMessage(result.reply);
      setClarifications(result.clarifications || []);
      
      const isActuallyComplete = fields.length > 0 && fields.every(f => !!newValues[f.id]);

      speak(result.reply, () => {
        if (!isActuallyComplete) {
          // Auto-start listening after AI finishes speaking
          setTimeout(() => {
            startListening();
          }, 300);
        } else {
          showFeedback("Form complete!", "success");
          setAiMessage("All fields are filled! Please review the data and submit when ready.");
        }
      });

      if (Object.keys(result.extracted).length > 0) {
        showFeedback(`Updated ${Object.keys(result.extracted).length} field(s)`, "success");
      } else {
        showFeedback("Listening...", "info");
      }
    } catch (error) {
      console.error("Extraction error:", error);
      showFeedback("Failed to process. Try again.", "error");
      setAiMessage("Sorry, I had trouble processing that. Could you try again?");
    } finally {
      setIsProcessing(false);
      processingRef.current = false;
    }
  };

  const { isListening, transcript, startListening, stopListening, getCurrentTranscript } = useSpeechRecognition({
    onResult: () => {},
    onEnd: (finalTranscript: string) => {
      if (finalTranscript.trim() && !processingRef.current) {
        processConversation(finalTranscript);
      }
    }
  });

  const toggleListening = async () => {
    if (isListening) {
      const finalTranscript = getCurrentTranscript();
      stopListening();
      if (finalTranscript.trim()) {
        processConversation(finalTranscript);
      }
    } else {
      // Cancel any ongoing TTS before listening
      window.speechSynthesis.cancel();
      startListening();
    }
  };

  const handleExportCSV = () => {
    if (Object.keys(formValues).length === 0) {
      showFeedback("Nothing to export yet.", "info");
      return;
    }

    // Build CSV content
    const headers = fields.map(f => f.label);
    const values = fields.map(f => {
      const val = formValues[f.id] || '';
      // Escape values that contain commas or quotes
      const strVal = String(val);
      if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
        return `"${strVal.replace(/"/g, '""')}"`;
      }
      return strVal;
    });

    const csvContent = headers.join(',') + '\n' + values.join(',');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", url);
    downloadAnchorNode.setAttribute("download", "voicefill_form_data.csv");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    URL.revokeObjectURL(url);
    showFeedback("Exported as CSV!", "success");
  };

  const handleExportText = () => {
    if (Object.keys(formValues).length === 0) {
      showFeedback("Nothing to export yet.", "info");
      return;
    }

    // Build a clean readable text document
    let textContent = "═══════════════════════════════════════\n";
    textContent += "        VOICEFILL - FORM DATA EXPORT\n";
    textContent += "═══════════════════════════════════════\n\n";
    textContent += `Date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`;
    textContent += `Time: ${new Date().toLocaleTimeString('en-US')}\n`;
    textContent += `Total Fields: ${fields.length}\n\n`;
    textContent += "───────────────────────────────────────\n\n";
    
    fields.forEach(f => {
      const value = formValues[f.id] || '(not filled)';
      textContent += `${f.label}:\n  ${value}\n\n`;
    });

    textContent += "───────────────────────────────────────\n";
    textContent += "Generated by VoiceFill AI\n";

    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", url);
    downloadAnchorNode.setAttribute("download", "voicefill_form_data.txt");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    URL.revokeObjectURL(url);
    showFeedback("Exported as Text!", "success");
  };

  const [showExportMenu, setShowExportMenu] = useState(false);

  const resetAll = () => {
    setFields([]);
    setFormValues({});
    setUploadedImage(null);
    setAiMessage("Upload a form to get started.");
    setClarifications([]);
    setEditingField(null);
    window.speechSynthesis.cancel();
  };

  const filledCount = fields.filter(f => !!formValues[f.id]).length;
  const progress = fields.length > 0 ? (filledCount / fields.length) * 100 : 0;

  return (
    <div className="min-h-screen bg-[#f1f3f6] flex items-center justify-center p-4 md:p-8 font-sans">
      <div className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-2 gap-10 items-stretch min-h-[750px]">
        
        {/* Left Side: Interaction Hub */}
        <section className="bg-white rounded-[3rem] shadow-2xl shadow-blue-900/5 p-10 flex flex-col justify-between border border-white/50 relative">
          <input type="file" hidden ref={fileInputRef} accept="image/*" onChange={handleFileUpload} />
          
          <div className="space-y-10">
            <header className="flex justify-between items-start">
              <div>
                <h1 className="text-4xl font-black tracking-tighter text-gray-900">
                  VoiceFill<span className="text-blue-600">.</span>
                </h1>
                <p className="text-gray-400 font-medium text-sm mt-1 uppercase tracking-widest">Intelligent Intake</p>
              </div>
              <div className="flex gap-2">
                <button onClick={resetAll} className="p-2 hover:bg-gray-50 rounded-full transition-colors text-gray-400" title="Reset">
                  <RotateCcw className="w-5 h-5" />
                </button>
              </div>
            </header>

            {/* AI Avatar / Message Area */}
            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all flex-shrink-0 ${isProcessing ? 'bg-blue-600 animate-pulse' : 'bg-black shadow-lg shadow-black/10'}`}>
                  {isProcessing ? <Loader2 className="w-6 h-6 text-white animate-spin" /> : <Sparkles className="w-6 h-6 text-white" />}
                </div>
                <div className="flex-grow">
                  <div className="bg-gray-50 p-5 rounded-3xl rounded-tl-none border border-gray-100 relative min-h-[80px] flex flex-col justify-center">
                    {isProcessing ? (
                      <div className="flex items-center gap-3">
                        <div className="flex gap-1">
                          <motion.span animate={{ opacity: [0, 1, 0] }} transition={{ repeat: Infinity, duration: 1 }} className="w-2 h-2 bg-blue-600 rounded-full" />
                          <motion.span animate={{ opacity: [0, 1, 0] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className="w-2 h-2 bg-blue-600 rounded-full" />
                          <motion.span animate={{ opacity: [0, 1, 0] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className="w-2 h-2 bg-blue-600 rounded-full" />
                        </div>
                        <span className="text-gray-400 text-sm font-medium italic">VoiceFill is thinking...</span>
                      </div>
                    ) : (
                      <>
                        <p className="text-gray-800 font-medium leading-relaxed">
                          {aiMessage}
                        </p>
                        {clarifications.length > 0 && (
                          <div className="mt-3 flex items-start gap-2 text-amber-600 bg-amber-50 p-3 rounded-2xl border border-amber-100">
                            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                            <p className="text-xs font-medium">{clarifications.join(' | ')}</p>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {!uploadedImage && !isAnalyzing && (
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className="group cursor-pointer border-2 border-dashed border-gray-200 rounded-[2.5rem] py-16 flex flex-col items-center justify-center gap-4 hover:border-blue-400 hover:bg-blue-50/50 transition-all"
                >
                  <div className="w-16 h-16 rounded-full bg-gray-50 group-hover:bg-blue-100 flex items-center justify-center transition-all">
                    <Upload className="w-7 h-7 text-gray-400 group-hover:text-blue-600" />
                  </div>
                  <p className="text-gray-500 font-semibold group-hover:text-blue-600">Drop your form here</p>
                </div>
              )}

              {uploadedImage && (
                <div className="relative group rounded-3xl overflow-hidden border border-gray-100 shadow-sm aspect-video bg-black/5">
                  <img src={uploadedImage} className="w-full h-full object-contain" alt="Current Form" />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <button onClick={() => fileInputRef.current?.click()} className="px-4 py-2 bg-white rounded-full text-xs font-bold text-black flex items-center gap-2">
                      <Upload className="w-3 h-3" /> Swap Image
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Action Area */}
          <div className="space-y-6">
            {/* Live transcript display */}
            <div className={`min-h-[60px] p-4 bg-gray-50 rounded-2xl border border-gray-100 transition-all ${isListening ? 'ring-2 ring-blue-500 bg-white' : ''}`}>
              <div className="flex items-start gap-3">
                <MessageSquare className={`w-5 h-5 mt-1 flex-shrink-0 ${isListening ? 'text-blue-600' : 'text-gray-300'}`} />
                <div className="flex-grow">
                  <p className={`text-sm ${isListening ? 'text-gray-900 font-medium' : 'text-gray-400 italic'}`}>
                    {isListening ? (transcript || "Listening... speak now") : "Your voice will appear here..."}
                  </p>
                  {isListening && (
                    <div className="flex items-center gap-1 mt-2">
                      {[...Array(5)].map((_, i) => (
                        <motion.div
                          key={i}
                          animate={{ scaleY: [1, 2, 1] }}
                          transition={{ repeat: Infinity, duration: 0.5, delay: i * 0.1 }}
                          className="w-1 h-3 bg-blue-500 rounded-full"
                        />
                      ))}
                      <span className="text-[10px] text-blue-500 font-bold ml-2 uppercase tracking-wider">Recording</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <button
              onClick={toggleListening}
              disabled={!uploadedImage || isAnalyzing || isProcessing}
              className={`w-full py-6 rounded-[2rem] text-xl font-bold flex items-center justify-center gap-4 transition-all shadow-2xl ${
                isListening 
                  ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-200 active:scale-95'
                  : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-200 active:scale-95'
              } disabled:opacity-20 disabled:grayscale disabled:cursor-not-allowed`}
            >
              <AnimatePresence mode="wait">
                {isListening ? (
                  <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-3">
                    <MicOff className="w-6 h-6" /> Finish Speaking
                  </motion.span>
                ) : (
                  <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-3">
                    <Mic className="w-6 h-6" /> Start Talking
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          </div>
        </section>

        {/* Right Side: Visual Data Grid */}
        <section className="bg-gray-950 rounded-[3rem] p-10 flex flex-col shadow-2xl">
          <div className="flex justify-between items-center mb-6">
            <div className="flex items-center gap-3">
               <div className="w-2 h-8 bg-blue-600 rounded-full" />
               <h2 className="text-2xl font-bold text-white tracking-tight">Structured Data</h2>
            </div>
            {feedback && feedback.type !== 'ai' && (
              <motion.div initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} className={`px-4 py-2 rounded-xl text-xs font-bold ${
                feedback.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 
                feedback.type === 'warning' ? 'bg-amber-500/10 text-amber-400' :
                feedback.type === 'error' ? 'bg-red-500/10 text-red-400' :
                'bg-blue-500/10 text-blue-400'
              }`}>
                {feedback.text}
              </motion.div>
            )}
          </div>

          {/* Progress bar */}
          {fields.length > 0 && (
            <div className="mb-6">
              <div className="flex justify-between items-center mb-2">
                <span className="text-gray-500 text-[10px] uppercase font-black tracking-widest">{filledCount} of {fields.length} fields</span>
                <span className="text-blue-400 text-xs font-bold">{Math.round(progress)}%</span>
              </div>
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <motion.div 
                  className="h-full bg-gradient-to-r from-blue-600 to-blue-400 rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                />
              </div>
            </div>
          )}

          <div className="flex-grow space-y-3 overflow-y-auto pr-2 custom-scrollbar">
            {fields.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-10 border border-gray-900 rounded-[2.5rem]">
                <Volume2 className="w-12 h-12 text-gray-800 mb-6" />
                <p className="text-gray-600 font-medium">Fields will automatically appear <br /> after scan.</p>
              </div>
            ) : (
              fields.map((field) => (
                <motion.div 
                  key={field.id}
                  initial={false}
                  animate={{ 
                    scale: formValues[field.id] ? 1.02 : 1,
                    backgroundColor: formValues[field.id] ? "rgba(37, 99, 235, 0.05)" : "rgba(17, 24, 39, 1)"
                  }}
                  className={`p-6 rounded-[2rem] border transition-all duration-500 ${
                    formValues[field.id] 
                      ? 'border-blue-600/40 shadow-lg shadow-blue-900/10' 
                      : 'border-gray-800'
                  }`}
                >
                  <label className="text-gray-600 text-[10px] uppercase font-black tracking-widest mb-3 block flex items-center justify-between">
                    {field.label}
                    <div className="flex items-center gap-2">
                      {formValues[field.id] && <span className="text-blue-500 text-[8px] animate-pulse">FILLED</span>}
                      <button 
                        onClick={() => setEditingField(editingField === field.id ? null : field.id)}
                        className="text-gray-600 hover:text-white transition-colors"
                        title="Edit manually"
                      >
                        <PenLine className="w-3 h-3" />
                      </button>
                    </div>
                  </label>
                  <div className="flex items-center justify-between gap-4">
                    <input
                      type={field.type}
                      value={formValues[field.id] || ''}
                      onChange={(e) => setFormValues(prev => ({ ...prev, [field.id]: e.target.value }))}
                      readOnly={editingField !== field.id}
                      className={`bg-transparent border-none text-white text-lg font-bold w-full outline-none placeholder-gray-800 ${
                        editingField === field.id ? 'ring-1 ring-blue-500 rounded-lg px-2 py-1' : ''
                      }`}
                      placeholder="Pending..."
                      onBlur={() => setEditingField(null)}
                    />
                    <AnimatePresence>
                      {formValues[field.id] && (
                        <motion.div
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0, opacity: 0 }}
                        >
                          <CheckCircle2 className="w-6 h-6 text-blue-500" />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              ))
            )}
          </div>

          {/* Export buttons */}
          <div className="mt-10 relative">
            <div className="grid grid-cols-2 gap-3">
              <button 
                onClick={handleExportCSV}
                className="py-5 bg-white text-black font-black uppercase tracking-widest rounded-[2rem] hover:bg-gray-100 transition-all flex items-center justify-center gap-2 active:scale-95 shadow-xl shadow-blue-500/5 text-sm"
              >
                <Download className="w-4 h-4" /> CSV
              </button>
              <button 
                onClick={handleExportText}
                className="py-5 bg-blue-600 text-white font-black uppercase tracking-widest rounded-[2rem] hover:bg-blue-700 transition-all flex items-center justify-center gap-2 active:scale-95 shadow-xl shadow-blue-500/5 text-sm"
              >
                <FileText className="w-4 h-4" /> Report
              </button>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}
