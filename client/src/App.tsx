import { Routes, Route } from "react-router-dom";
import BaseLayout from "./layouts/BaseLayout";
import NotePage from "./components/NotePage/NotePage";
import Home from "./components/Home/Home";

export default function App() {
  return (
    <Routes>
      <Route element={<BaseLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/:id" element={<NotePage />} />
      </Route>
    </Routes>
  );
}
