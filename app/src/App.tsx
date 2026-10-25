import { lazy, Suspense } from "react";
import { HashRouter, Link, Route, Routes } from "react-router-dom";
import { LangProvider, useStrings } from "./i18n/index.tsx";
import { common } from "./i18n/common.ts";
import { Layout } from "./components/Layout.tsx";
import { Loading } from "./components/ui.tsx";
import { Story } from "./pages/Story.tsx";

const Passport = lazy(() => import("./pages/Passport.tsx"));
const Verify = lazy(() => import("./pages/Verify.tsx"));
const Recycler = lazy(() => import("./pages/Recycler.tsx"));
const Maker = lazy(() => import("./pages/Maker.tsx"));
const Attacks = lazy(() => import("./pages/Attacks.tsx"));
const Impact = lazy(() => import("./pages/Impact.tsx"));
const Device = lazy(() => import("./pages/Device.tsx"));
const Gs1 = lazy(() => import("./pages/Gs1.tsx"));

function NotFound() {
  const s = useStrings(common);
  return (
    <div className="stack-md">
      <h1>{s.notFound}</h1>
      <Link className="btn btn-ink" to="/">{s.goHome}</Link>
    </div>
  );
}

export function App() {
  return (
    <LangProvider>
      <HashRouter>
        <Layout>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Story />} />
              <Route path="/p/:id" element={<Passport />} />
              <Route path="/verify" element={<Verify />} />
              <Route path="/verify/:id" element={<Verify />} />
              <Route path="/recycler" element={<Recycler />} />
              <Route path="/maker" element={<Maker />} />
              <Route path="/attacks" element={<Attacks />} />
              <Route path="/impact" element={<Impact />} />
              <Route path="/device" element={<Device />} />
              <Route path="/01/:gtin/21/:serial" element={<Gs1 />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </Layout>
      </HashRouter>
    </LangProvider>
  );
}
