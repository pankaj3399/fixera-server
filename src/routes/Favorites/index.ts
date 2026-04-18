import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth";
import {
  toggleFavorite,
  listUserFavorites,
  getFavoriteStatusBatch,
} from "../../handlers/Favorites";

const favoritesRouter = Router();

favoritesRouter.use(authMiddleware(["customer"]));

favoritesRouter.route("/toggle").post(toggleFavorite);
favoritesRouter.route("/").get(listUserFavorites);
favoritesRouter.route("/status").post(getFavoriteStatusBatch);

export default favoritesRouter;
