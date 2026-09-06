/**
 * VoiceFill AI - Content Script
 * Injected into Google Forms pages to scan form fields and auto-fill values.
 */

(() => {
  'use strict';

  // Prevent double injection
  if (window.__voicefillInjected) return;
  window.__voicefillInjected = true;

  console.log('[VoiceFill] Content script loaded on Google Forms page');

  /**
   * Scan the Google Forms DOM and extract all questions/fields.
   * Google Forms uses specific data attributes and class patterns.
   */
  function scanFormFields() {
    const fields = [];
    
    // Google Forms question containers use [data-params] on the question wrapper
    // Each question block is inside a div with role="listitem"
    const questionBlocks = document.querySelectorAll('[role="listitem"]');
    
    questionBlocks.forEach((block, index) => {
      // Get the question title
      const titleEl = block.querySelector('[data-item-id] [role="heading"]') 
        || block.querySelector('.M7eMe') // Question title class
        || block.querySelector('[dir="auto"]'); // Fallback
      
      if (!titleEl) return;
      
      const label = titleEl.textContent.trim();
      if (!label) return;
      
      // Determine field type by looking at input elements inside
      let type = 'text';
      let inputSelector = '';

      // Short answer (text input)
      const textInput = block.querySelector('input[type="text"]');
      // Long answer (textarea)
      const textArea = block.querySelector('textarea');
      // Radio buttons
      const radioButtons = block.querySelectorAll('[role="radio"]');
      // Checkboxes
      const checkboxes = block.querySelectorAll('[role="checkbox"]');
      // Dropdown
      const dropdown = block.querySelector('[role="listbox"]');
      // Date input: only treat as date when there is REAL date structure
      // (a native date input, an explicit data-input-type, or multiple part
      // inputs labeled day/month/year). Never guess from the label text alone,
      // otherwise questions like "describe your perfect date idea" break.
      const allInputs = block.querySelectorAll('input');
      const partLabels = Array.from(allInputs).map(i => (i.getAttribute('aria-label') || '') + ' ' + (i.getAttribute('placeholder') || ''));
      const datePartCount = partLabels.filter(l => /day|month|year|dd|mm|yyyy/i.test(l)).length;
      const dateInput = block.querySelector('input[type="date"]')
        || block.querySelector('[data-input-type="date"]')
        || (allInputs.length >= 2 && datePartCount >= 2 ? allInputs[0] : null);
      // Email
      const emailInput = label.toLowerCase().includes('email') ? textInput : null;

      if (emailInput) {
        type = 'email';
        inputSelector = 'email';
      } else if (dateInput) {
        type = 'date';
        inputSelector = 'date';
      } else if (textInput) {
        type = 'text';
        inputSelector = 'text-input';
      } else if (textArea) {
        type = 'textarea';
        inputSelector = 'textarea';
      } else if (radioButtons.length > 0) {
        type = 'radio';
        inputSelector = 'radio';
      } else if (checkboxes.length > 0) {
        type = 'checkbox';
        inputSelector = 'checkbox';
      } else if (dropdown) {
        type = 'dropdown';
        inputSelector = 'dropdown';
      } else {
        // Try to find any input
        const anyInput = block.querySelector('input');
        if (anyInput) {
          type = 'text';
          inputSelector = 'text-input';
        } else {
          return; // Skip if no input found
        }
      }

      // Get options for radio/checkbox/dropdown
      let options = [];
      if (type === 'radio') {
        radioButtons.forEach(rb => {
          const optLabel = rb.querySelector('[dir="auto"]') || rb.closest('[data-value]');
          if (optLabel) {
            options.push(optLabel.textContent.trim());
          }
        });
      } else if (type === 'checkbox') {
        checkboxes.forEach(cb => {
          const optLabel = cb.querySelector('[dir="auto"]') || cb.closest('[data-value]');
          if (optLabel) {
            options.push(optLabel.textContent.trim());
          }
        });
      }

      const id = `field_${index}_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '')}`;
      
      fields.push({
        id,
        label,
        type,
        inputSelector,
        options: options.length > 0 ? options : undefined,
        blockIndex: index
      });
    });

    // Fallback: if listitem didn't work, try other selectors
    if (fields.length === 0) {
      // Try finding all visible inputs and textareas
      const allInputs = document.querySelectorAll('input[type="text"], textarea, input[type="email"], input[type="number"]');
      allInputs.forEach((input, index) => {
        // Try to find label
        const container = input.closest('[data-params]') || input.closest('.freebirdFormviewerComponentsQuestionBaseRoot') || input.parentElement?.parentElement;
        const labelEl = container?.querySelector('[role="heading"]') || container?.querySelector('.M7eMe');
        const label = labelEl?.textContent?.trim() || input.getAttribute('aria-label') || `Field ${index + 1}`;
        
        if (label) {
          fields.push({
            id: `field_${index}_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '')}`,
            label,
            type: input.type === 'email' ? 'email' : 'text',
            inputSelector: input.tagName === 'TEXTAREA' ? 'textarea' : 'text-input',
            blockIndex: index
          });
        }
      });
    }

    console.log(`[VoiceFill] Scanned ${fields.length} form fields:`, fields);
    return fields;
  }

  /**
   * Fill a specific form field with a value.
   */
  function fillField(fieldId, value, fields) {
    const field = fields.find(f => f.id === fieldId);
    if (!field) {
      console.warn(`[VoiceFill] Field not found: ${fieldId}`);
      return false;
    }

    const questionBlocks = document.querySelectorAll('[role="listitem"]');
    const block = questionBlocks[field.blockIndex];
    if (!block) {
      console.warn(`[VoiceFill] Question block not found at index ${field.blockIndex}`);
      return false;
    }

    try {
      switch (field.inputSelector) {
        case 'text-input':
        case 'email': {
          const input = block.querySelector('input[type="text"], input[type="email"], input[type="number"], input');
          if (input) {
            // Use native setter to trigger React/Polymer change detection
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
            console.log(`[VoiceFill] Filled text field "${field.label}" with "${value}"`);
            return true;
          }
          break;
        }

        case 'textarea': {
          const textarea = block.querySelector('textarea');
          if (textarea) {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            nativeSetter.call(textarea, value);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            textarea.dispatchEvent(new Event('blur', { bubbles: true }));
            console.log(`[VoiceFill] Filled textarea "${field.label}" with "${value}"`);
            return true;
          }
          break;
        }

        case 'date': {
          // Google Forms date fields have separate day/month/year inputs
          const dateInputs = block.querySelectorAll('input');
          if (dateInputs.length >= 3) {
            // Try to parse the date
            const dateParts = value.match(/(\d{4})-(\d{2})-(\d{2})/);
            if (dateParts) {
              const [, year, month, day] = dateParts;
              // Google Forms date order: DD, MM, YYYY (or varies by locale)
              const inputs = Array.from(dateInputs);
              inputs.forEach(input => {
                const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
                const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
                const label = ariaLabel + placeholder;
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                
                if (label.includes('day') || label.includes('dd')) {
                  nativeSetter.call(input, day);
                } else if (label.includes('month') || label.includes('mm')) {
                  nativeSetter.call(input, month);
                } else if (label.includes('year') || label.includes('yyyy')) {
                  nativeSetter.call(input, year);
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              });
              console.log(`[VoiceFill] Filled date field "${field.label}" with "${value}"`);
              return true;
            }
          }
          // Fallback: single date input
          const singleDateInput = block.querySelector('input[type="date"]') || block.querySelector('input');
          if (singleDateInput) {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(singleDateInput, value);
            singleDateInput.dispatchEvent(new Event('input', { bubbles: true }));
            singleDateInput.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          break;
        }

        case 'radio': {
          const radios = block.querySelectorAll('[role="radio"]');
          const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
          const valueN = norm(value);

          // 1. Exact match first (never falls through to a substring hit)
          for (const radio of radios) {
            if (norm(radio.textContent) === valueN) {
              radio.click();
              console.log(`[VoiceFill] Selected radio "${field.label}" -> "${value}"`);
              return true;
            }
          }
          // 2. Whole-phrase containment (long enough to be unambiguous)
          if (valueN.length >= 4) {
            for (const radio of radios) {
              const t = norm(radio.textContent);
              if (t && t.includes(valueN)) {
                radio.click();
                console.log(`[VoiceFill] Selected radio "${field.label}" -> "${value}"`);
                return true;
              }
            }
          }
          // 3. Word-boundary fuzzy match — "female" must never match "male"
          const words = valueN.split(' ').filter(w => w.length > 2);
          for (const radio of radios) {
            const t = norm(radio.textContent);
            if (t && words.some(w => new RegExp(`\\b${w}\\b`).test(t))) {
              radio.click();
              console.log(`[VoiceFill] Fuzzy selected radio "${field.label}" -> "${radio.textContent.trim()}"`);
              return true;
            }
          }
          break;
        }

        case 'checkbox': {
          const checkboxes = block.querySelectorAll('[role="checkbox"]');
          const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
          const selectedValues = value.split(/[,;]+/).map(v => norm(v)).filter(Boolean);
          let matched = false;

          for (const cb of checkboxes) {
            const optText = norm(cb.textContent);
            const shouldCheck = selectedValues.some(sv =>
              optText === sv || (sv.length >= 4 && optText.includes(sv)) || optText.split(' ').every(w => sv.includes(w))
            );
            if (shouldCheck) {
              const isChecked = cb.getAttribute('aria-checked') === 'true';
              if (!isChecked) {
                cb.click();
              }
              matched = true;
            }
          }
          if (matched) {
            console.log(`[VoiceFill] Checked checkbox(es) for "${field.label}"`);
            return true;
          }
          break;
        }

        case 'dropdown': {
          const listbox = block.querySelector('[role="listbox"]');
          if (listbox) {
            // Click to open the dropdown menu
            listbox.click();
            // Google Forms renders the options menu into an app-level overlay.
            // Poll for the open menu (a role=listbox containing role=option children)
            // so we only ever click options that belong to THIS dropdown, never
            // checkboxes or radios elsewhere on the page.
            const deadline = Date.now() + 3000;
            const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
            const valueN = norm(value);
            const trySelect = () => {
              // Prefer menus that are open role=listbox containers with options;
              // fall back to any visible role=option (rendered in app-level overlays).
              let optionEls = [];
              const menus = Array.from(document.querySelectorAll('[role="listbox"]')).filter(l => l.querySelector('[role="option"]'));
              for (const menu of menus) optionEls.push(...menu.querySelectorAll('[role="option"]'));
              if (optionEls.length === 0) {
                optionEls = Array.from(document.querySelectorAll('[role="option"]')).filter(el => el.getClientRects().length > 0);
              }
              for (const opt of optionEls) {
                if (norm(opt.textContent) === valueN) { opt.click(); return true; }
              }
              for (const opt of optionEls) {
                const t = norm(opt.textContent);
                if (valueN.length >= 4 && t && t.includes(valueN)) { opt.click(); return true; }
              }
              const words = valueN.split(' ').filter(w => w.length > 2);
              for (const opt of optionEls) {
                const t = norm(opt.textContent);
                if (t && words.some(w => new RegExp(`\\b${w}\\b`).test(t))) { opt.click(); return true; }
              }
              return false;
            };
            const poll = () => {
              if (trySelect()) {
                console.log(`[VoiceFill] Selected dropdown "${field.label}" -> "${value}"`);
              } else if (Date.now() < deadline) {
                setTimeout(poll, 150);
              } else {
                console.warn(`[VoiceFill] Dropdown option not found for "${field.label}": ${value}`);
              }
            };
            poll();
            return true;
          }
          break;
        }
      }
    } catch (err) {
      console.error(`[VoiceFill] Error filling field "${field.label}":`, err);
    }

    return false;
  }

  // Store scanned fields for reuse
  let cachedFields = [];

  // Listen for messages from the popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[VoiceFill] Content script received message:', message.type);

    switch (message.type) {
      case 'SCAN_FORM': {
        cachedFields = scanFormFields();
        sendResponse({ success: true, fields: cachedFields });
        break;
      }

      case 'FILL_FIELD': {
        const { fieldId, value } = message;
        if (cachedFields.length === 0) {
          cachedFields = scanFormFields();
        }
        const success = fillField(fieldId, value, cachedFields);
        sendResponse({ success });
        break;
      }

      case 'FILL_MULTIPLE': {
        const { values } = message;
        if (cachedFields.length === 0) {
          cachedFields = scanFormFields();
        }
        const results = {};
        for (const [fieldId, value] of Object.entries(values)) {
          results[fieldId] = fillField(fieldId, value, cachedFields);
        }
        sendResponse({ success: true, results });
        break;
      }

      case 'PING': {
        sendResponse({ success: true, message: 'VoiceFill content script is active' });
        break;
      }

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }

    return true; // Keep channel open for async response
  });

  // Notify that content script is ready
  console.log('[VoiceFill] Content script ready and listening for messages');
})();
