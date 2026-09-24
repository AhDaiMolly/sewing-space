import { Outlet } from 'react-router-dom';
import ToastContainer from './components/Toast';

export default function App() {
  return (
    <>
      <ToastContainer />
      <Outlet />
    </>
  );
}