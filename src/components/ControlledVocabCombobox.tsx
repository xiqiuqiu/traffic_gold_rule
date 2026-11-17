import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import {
  ControlledVocabOption,
  filterControlledVocabOptions,
  stepVocabHighlightIndex,
} from '../utils/goldRules';

interface ControlledVocabComboboxProps {
  id?: string;
  ariaLabel?: string;
  options: ControlledVocabOption[];
  multiple?: boolean;
  selectedValues: string[];
  onChangeValues: (nextValues: string[]) => void;
  allowCustomInput?: boolean;
  placeholder?: string;
  emptyMatchText?: string;
  compact?: boolean;
}

export const ControlledVocabCombobox: React.FC<ControlledVocabComboboxProps> = ({
  id,
  ariaLabel,
  options,
  multiple = false,
  selectedValues,
  onChangeValues,
  allowCustomInput = false,
  placeholder,
  emptyMatchText,
  compact = false,
}) => {
  const generatedId = useId();
  const inputId = id || `vocab-combo-${generatedId}`;
  const listboxId = `${inputId}-listbox`;

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);

  const singleValue = !multiple ? selectedValues[0] || '' : '';

  const [isOpen, setIsOpen] = useState(false);
  const [isFiltering, setIsFiltering] = useState(false);
  const [inputText, setInputText] = useState<string>(multiple ? '' : singleValue);
  const [highlightIndex, setHighlightIndex] = useState<number>(-1);

  // Sync external value changes when not actively typing a filter query
  useEffect(() => {
    if (!multiple && !isFiltering) {
      setInputText(singleValue);
    }
  }, [multiple, singleValue, isFiltering]);

  const effectiveQuery = isFiltering ? inputText : '';

  const filteredOptions = useMemo(
    () => filterControlledVocabOptions(options, effectiveQuery),
    [options, effectiveQuery],
  );

  // Keep highlightIndex valid when filteredOptions changes externally
  useEffect(() => {
    if (!isOpen) return;
    if (filteredOptions.length === 0) {
      setHighlightIndex(-1);
      return;
    }
    setHighlightIndex((prev) => (prev >= filteredOptions.length ? 0 : prev));
  }, [filteredOptions, isOpen]);

  // Ensure keyboard-highlighted option stays visible inside scrollable listbox
  useEffect(() => {
    if (!isOpen || highlightIndex < 0) return;
    const el = optionRefs.current[highlightIndex];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, highlightIndex]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setIsFiltering(false);
        if (!multiple) {
          setInputText(singleValue);
        } else {
          setInputText('');
        }
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isOpen, multiple, singleValue]);

  const openDropdown = (startFiltering = false) => {
    setIsOpen(true);
    setIsFiltering(startFiltering);
    const list = startFiltering ? filterControlledVocabOptions(options, inputText) : options;
    if (list.length === 0) {
      setHighlightIndex(-1);
      return;
    }
    if (!multiple && singleValue && !startFiltering) {
      const selectedIdx = list.findIndex((o) => o.value === singleValue);
      setHighlightIndex(selectedIdx >= 0 ? selectedIdx : 0);
    } else {
      setHighlightIndex(0);
    }
  };

  const commitOption = (optionValue: string, trigger: 'keyboard' | 'mouse') => {
    if (multiple) {
      const exists = selectedValues.includes(optionValue);
      const next = exists
        ? selectedValues.filter((v) => v !== optionValue)
        : [...selectedValues, optionValue];
      onChangeValues(next);
      setInputText('');
      setIsFiltering(false);
      if (trigger === 'keyboard') {
        setIsOpen(false);
      } else {
        setIsOpen(true);
      }
      return;
    }

    onChangeValues([optionValue]);
    setInputText(optionValue);
    setIsFiltering(false);
    setIsOpen(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextText = e.target.value;
    setInputText(nextText);
    setIsFiltering(true);
    setIsOpen(true);

    const nextFiltered = filterControlledVocabOptions(options, nextText);
    setHighlightIndex(nextFiltered.length > 0 ? 0 : -1);

    if (!multiple && allowCustomInput) {
      onChangeValues(nextText ? [nextText] : []);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        openDropdown(isFiltering);
      } else {
        setHighlightIndex((prev) =>
          stepVocabHighlightIndex(prev, filteredOptions.length, 'next'),
        );
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setHighlightIndex(filteredOptions.length > 0 ? filteredOptions.length - 1 : -1);
      } else {
        setHighlightIndex((prev) =>
          stepVocabHighlightIndex(prev, filteredOptions.length, 'prev'),
        );
      }
      return;
    }

    if (e.key === 'Enter') {
      if (isOpen && highlightIndex >= 0 && filteredOptions[highlightIndex]) {
        e.preventDefault();
        commitOption(filteredOptions[highlightIndex].value, 'keyboard');
      } else if (!multiple && allowCustomInput && isOpen) {
        setIsOpen(false);
        setIsFiltering(false);
      }
      return;
    }

    if (e.key === 'Escape') {
      if (isOpen) {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(false);
        setIsFiltering(false);
        setInputText(multiple ? '' : singleValue);
      }
      return;
    }

    if (e.key === 'Tab') {
      setIsOpen(false);
      setIsFiltering(false);
      if (!multiple) {
        setInputText(singleValue);
      } else {
        setInputText('');
      }
    }
  };

  const activeDescendantId =
    isOpen && highlightIndex >= 0 && filteredOptions[highlightIndex]
      ? `${listboxId}-opt-${highlightIndex}`
      : undefined;

  const defaultPlaceholder = multiple
    ? '输入关键词检索词表（支持 ↑↓ 方向键选择）'
    : '输入关键词检索或选择标准词表取值…';

  return (
    <div ref={containerRef} className="relative w-full">
      {multiple && selectedValues.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {selectedValues.map((val) => (
            <span
              key={val}
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-800"
            >
              <span>{val}</span>
              <button
                type="button"
                aria-label={`移除 ${val}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChangeValues(selectedValues.filter((item) => item !== val));
                }}
                className="rounded text-slate-400 transition-colors hover:text-red-700"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        className={`flex items-center rounded-md border border-slate-300 bg-white transition-colors focus-within:border-blue-600 focus-within:ring-1 focus-within:ring-blue-600/20 ${
          compact ? 'px-2 py-1' : 'px-2.5 py-1.5'
        }`}
      >
        {multiple && (
          <Search className="mr-1.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
        )}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-activedescendant={activeDescendantId}
          value={inputText}
          onFocus={() => {
            if (!isOpen) openDropdown(false);
          }}
          onClick={() => {
            if (!isOpen) openDropdown(false);
          }}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || defaultPlaceholder}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none"
        />

        {((!multiple && (inputText || singleValue)) || (multiple && inputText)) && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="清空当前输入"
            onClick={(e) => {
              e.stopPropagation();
              if (!multiple) {
                onChangeValues([]);
              }
              setInputText('');
              setIsFiltering(true);
              setIsOpen(true);
              setHighlightIndex(options.length > 0 ? 0 : -1);
              inputRef.current?.focus();
            }}
            className="ml-1 rounded p-0.5 text-slate-400 transition-colors hover:text-slate-700"
          >
            <X className="h-3 w-3" />
          </button>
        )}

        <button
          type="button"
          tabIndex={-1}
          aria-label="展开或收起词表选项"
          onMouseDown={(e) => {
            e.preventDefault();
            if (isOpen) {
              setIsOpen(false);
              setIsFiltering(false);
              setInputText(multiple ? '' : singleValue);
            } else {
              openDropdown(false);
              inputRef.current?.focus();
            }
          }}
          className="ml-1 rounded p-0.5 text-slate-400 transition-colors hover:text-slate-700"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-150 ${
              isOpen ? 'rotate-180 text-slate-700' : ''
            }`}
          />
        </button>
      </div>

      {isOpen && (
        <ul
          id={listboxId}
          role="listbox"
          aria-multiselectable={multiple || undefined}
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-md"
        >
          {filteredOptions.length === 0 ? (
            <li className="px-3 py-2 text-xs text-slate-500">
              {emptyMatchText ||
                (allowCustomInput
                  ? '未命中预设词表，可直接保留当前输入作为标准结论'
                  : '未找到匹配的词表条目')}
            </li>
          ) : (
            filteredOptions.map((opt, idx) => {
              const isSelected = selectedValues.includes(opt.value);
              const isHighlighted = idx === highlightIndex;
              const showSynonymHint =
                Boolean(opt.synonymsText) &&
                isFiltering &&
                effectiveQuery.trim().length > 0 &&
                !opt.value.toLowerCase().includes(effectiveQuery.trim().toLowerCase());

              return (
                <li
                  key={opt.value}
                  id={`${listboxId}-opt-${idx}`}
                  ref={(el) => {
                    optionRefs.current[idx] = el;
                  }}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setHighlightIndex(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commitOption(opt.value, 'mouse');
                  }}
                  className={`flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-xs transition-colors ${
                    isHighlighted
                      ? 'bg-slate-100 text-slate-900'
                      : isSelected
                        ? 'bg-blue-50/50 text-slate-900'
                        : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {multiple && (
                        <span
                          className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                            isSelected
                              ? 'border-blue-600 bg-blue-600 text-white'
                              : 'border-slate-300 bg-white'
                          }`}
                          aria-hidden="true"
                        >
                          {isSelected && <Check className="h-2.5 w-2.5" />}
                        </span>
                      )}
                      <span className={`truncate ${isSelected ? 'font-medium text-slate-900' : ''}`}>
                        {opt.value}
                      </span>
                    </div>
                    {showSynonymHint && (
                      <div className="mt-0.5 truncate pl-0.5 text-[11px] text-slate-400">
                        近义词命中：{opt.synonymsText}
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {opt.source === 'supplement' && (
                      <span className="text-[11px] text-amber-700">补充词表</span>
                    )}
                    {!multiple && isSelected && (
                      <Check className="h-3.5 w-3.5 text-blue-700" aria-hidden="true" />
                    )}
                  </div>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
};
