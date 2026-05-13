import 'react';

declare module 'react' {
  interface InputHTMLAttributes<T> {
    /** Firefox-specific: makes <input type="range"> render vertically. Non-standard, Firefox-only. */
    orient?: string;
  }
}
