"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AvsRandom = void 0;
const crypto_1 = __importDefault(require("crypto"));
class AvsRandom {
    static generateRandomString(length = 16) {
        return crypto_1.default
            .randomBytes(length)
            .toString('base64')
            .slice(0, length);
    }
}
exports.AvsRandom = AvsRandom;
