// Browser-only fixture. All API responses are synthetic and intercepted by the check script.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FutureStars } from '../../components/future-stars/future-stars';
createRoot(document.getElementById('root')!).render(<FutureStars />);
