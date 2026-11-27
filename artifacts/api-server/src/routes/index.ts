import { Router, type IRouter } from "express";
import healthRouter from "./health";
import elexonRouter from "./elexon";
import askRouter from "./ask";
import monitoringRouter from "./monitoring";

const router: IRouter = Router();

router.use(healthRouter);
router.use(elexonRouter);
router.use(askRouter);
router.use(monitoringRouter);

export default router;
