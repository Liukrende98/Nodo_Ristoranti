'use client';

import { useEffect, useState } from 'react';
import { useAuth, apiFetch } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';

export default function MenuPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    if (!authLoading && !user) { router.push('/login'); return; }
    if (user) {
      apiFetch('/api/menu').then((data: any) => {
        setItems(data.items);
        setCategories(data.categories);
      });
    }
  }, [user, authLoading, router]);

  if (authLoading) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <a href="/" className="text-gray-400 hover:text-gray-600">←</a>
          <h1 className="font-bold text-gray-900">📋 Menu</h1>
        </div>
      </header>
      <main className="max-w-5xl mx-auto p-4">
        {categories.map((cat) => (
          <div key={cat} className="mb-6">
            <h2 className="text-lg font-semibold text-gray-700 mb-3">{cat}</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.filter((i) => i.category === cat).map((item) => (
                <div key={item.id} className="card">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-medium">{item.name}</div>
                      {item.workflowTemplate && (
                        <div className="text-xs text-gray-500 mt-0.5">
                          Workflow: {item.workflowTemplate.name} (~{Number(item.workflowTemplate.estimatedTotalMinutes)}min)
                        </div>
                      )}
                      {item.recipeIngredients?.length > 0 && (
                        <div className="text-xs text-gray-400 mt-1">
                          Ingredienti: {item.recipeIngredients.map((r: any) => r.inventoryItem.name).join(', ')}
                        </div>
                      )}
                    </div>
                    <span className="text-lg font-bold text-blue-600">€{Number(item.price).toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}
